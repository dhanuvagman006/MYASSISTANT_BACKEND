/**
 * ASSISTANT MODULE — the realtime voice-loop backend the app's
 * `AssistantApi` (lib/core/network/assistant_api.dart) talks to.
 *
 * THIS WAS THE MISSING PIECE: the app has always POSTed to
 * /assistant/session, streamed /assistant/stream/:sid and uploaded mic
 * clips to /assistant/:sid/audio — but no such routes existed, so every
 * voice turn died with a 404 ("the agent is not detecting / responding").
 *
 * Protocol (mirrors the app's state machine one-to-one):
 *   POST /assistant/session                 -> { sessionId, streamToken }
 *   GET  /assistant/stream/:sid?token=…     -> SSE events (id: + data:)
 *   POST /assistant/:sid/audio  (multipart) -> 202; STT + reply stream back
 *   POST /assistant/:sid/message {text}     -> 202; reply streams back
 *   POST /assistant/:sid/contacts {matches} -> device-resolved contacts
 *   POST /assistant/:sid/choose {contactId} -> ambiguous pick
 *   POST /assistant/:sid/confirm {approved} -> yes/no on pending action
 *   POST /assistant/:sid/cancel             -> abort the turn
 *
 * Events emitted (all JSON on `data:`):
 *   assistant_state {state}   user_transcript {text}
 *   assistant_message {text}  tool_started/tool_completed {tool,label}
 *   contact_lookup {name}     contact_found / contacts_ambiguous /
 *   contact_not_found         confirmation_request {action,contact,…}
 *   call_status {status,contact_name}      error {message}
 *
 * Sessions are in-memory (single-node). Events are buffered per session
 * so a dropped SSE connection replays from Last-Event-ID seamlessly.
 */

const router = require("express").Router();
const crypto = require("crypto");
const multer = require("multer");

const { transcribeAudio } = require("../services/ai/router");
const { buildToolContext } = require("../services/intents");
const { runAgentTurn } = require("../agents/orchestrator");
const agentCall = require("../agents/agentCall");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
});

/* ------------------------------------------------------------------ */
/* Session store                                                       */
/* ------------------------------------------------------------------ */

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min idle
const MAX_BUFFER = 300; // replay buffer per session

/** sid -> session */
const sessions = new Map();

function newSession(userSub, userName) {
  const sid = crypto.randomUUID();
  const s = {
    sid,
    userSub: userSub || null,
    userName: userName || null,
    streamToken: crypto.randomBytes(24).toString("hex"),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    nextEventId: 1,
    buffer: [], // { id, json }
    res: null, // live SSE response
    history: [], // chat context [{role, content}]
    busy: false,
    cancelled: false,
    pending: null, // { action, contact } awaiting confirm
    pendingContactName: null, // waiting for device contact matches
    pendingCallTask: null, // agent-call task ("tell her I'll be late")
    agentRetries: 0, // retries used on the current agent-call request
  };
  sessions.set(sid, s);
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      try {
        s.res?.end();
      } catch (_) {}
      sessions.delete(sid);
    }
  }
}, 60_000).unref();

function getSession(req, res) {
  const s = sessions.get(req.params.sid);
  if (!s) {
    res.status(404).json({ error: "unknown assistant session" });
    return null;
  }
  s.lastSeen = Date.now();
  return s;
}

/* ------------------------------------------------------------------ */
/* SSE plumbing                                                        */
/* ------------------------------------------------------------------ */

function emit(s, event) {
  const id = s.nextEventId++;
  const json = JSON.stringify(event);
  s.buffer.push({ id, json });
  if (s.buffer.length > MAX_BUFFER) s.buffer.shift();
  if (s.res) {
    try {
      s.res.write(`id: ${id}\ndata: ${json}\n\n`);
    } catch (_) {
      s.res = null;
    }
  }
}

const state = (s, name) => emit(s, { type: "assistant_state", state: name });

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

// POST /assistant/session  (mounted behind appAuth in server.js)
router.post("/session", (req, res) => {
  const s = newSession(req.user?.sub, req.user?.name);
  res.json({ sessionId: s.sid, streamToken: s.streamToken });
});

// GET /assistant/stream/:sid?token=…
// EventSource-style clients can't send an Authorization header, so the
// stream authenticates with the per-session random token instead. This
// handler is mounted directly in server.js, BEFORE the appAuth-guarded
// router, so the token is its only gate.
function streamHandler(req, res) {
  const s = sessions.get(req.params.sid);
  if (!s || req.query.token !== s.streamToken) {
    return res.status(401).json({ error: "bad stream token" });
  }
  s.lastSeen = Date.now();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  // Replay anything missed while disconnected.
  const lastId = parseInt(req.get("Last-Event-ID") || "0", 10) || 0;
  for (const e of s.buffer) {
    if (e.id > lastId) res.write(`id: ${e.id}\ndata: ${e.json}\n\n`);
  }

  // Only one live stream per session — replace any previous one.
  try {
    s.res?.end();
  } catch (_) {}
  s.res = res;

  const heartbeat = setInterval(() => {
    try {
      res.write(": hb\n\n");
    } catch (_) {}
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    if (s.res === res) s.res = null;
  });
}

/* ---------------- turn handling ---------------- */

const CALL_RX =
  /\b(?:call|phone|dial|ring)\s+(?:up\s+)?([\p{L}\p{M}][\p{L}\p{M} .'-]{0,40})/iu;

// "call X and tell/ask/inform … <message or question>": Hari places the call
// itself, speaks on it, and reports back — vs a plain "call X" direct dial.
const AGENT_CALL_RX =
  /\b(?:call|phone|dial|ring)\s+(?:up\s+)?([\p{L}\p{M}][\p{L}\p{M} .'-]{0,40}?)\s+(?:and|to)\s+((?:ask|tell|inform|say|find out|let|remind|check|confirm)\b.*)$/iu;

function cleanName(raw) {
  return String(raw || "")
    .replace(/\b(please|now|for me)\b.*$/i, "")
    .replace(/^(my|the)\s+/i, "")
    .trim();
}

function detectAgentCall(text) {
  const m = AGENT_CALL_RX.exec(text);
  if (!m) return null;
  const name = cleanName(m[1]);
  let task = String(m[2] || "").trim();
  if (name.length < 2 || task.length < 3) return null;
  // "tell her …" → "tell <name> …" so the call AI has full context.
  task = task.replace(
    /^(ask|tell|inform|let|say to|confirm with|remind)\s+(him|her|them)\b/i,
    (_all, verb) => `${verb} ${name}`
  );
  return { name, task };
}

function detectCallIntent(text) {
  const m = CALL_RX.exec(text);
  if (!m) return null;
  // Trim trailing politeness ("call amma please").
  return m[1].replace(/\b(please|now|for me)\b.*$/i, "").trim() || null;
}

async function runTurn(s, req, userText) {
  s.busy = true;
  s.cancelled = false;
  try {
    // "Call mom and tell her I'll be late" — Hari phones the contact and
    // speaks on the call itself. Contacts live on the DEVICE, so we ask the
    // app to resolve the name first; the agent call is placed in /contacts.
    const agentReq = detectAgentCall(userText);
    if (agentReq) {
      s.pendingContactName = agentReq.name;
      s.pendingCallTask = agentReq.task;
      s.agentRetries = 0;
      state(s, "finding_contact");
      emit(s, { type: "contact_lookup", name: agentReq.name });
      return; // waits for POST /contacts
    }

    // "Call amma" — plain direct dial (contacts resolved on the device).
    const callee = detectCallIntent(userText);
    if (callee) {
      s.pendingContactName = callee;
      s.pendingCallTask = null;
      state(s, "finding_contact");
      emit(s, { type: "contact_lookup", name: callee });
      return; // waits for POST /contacts
    }

    state(s, "thinking");
    s.history.push({ role: "user", content: userText.slice(0, 8000) });
    if (s.history.length > 20) s.history = s.history.slice(-20);

    // Same tool layer the /chat route uses — reminders, weather, news,
    // documents… so the voice assistant knows everything chat knows.
    let toolBlock = "";
    try {
      const toolCtx = await buildToolContext({
        userId: Number(s.userSub) > 0 ? Number(s.userSub) : null,
        messages: s.history,
        tzOffsetMin: Number(req.get("X-TZ-Offset")) || 330,
        lat: parseFloat(req.get("X-Geo-Lat")),
        lng: parseFloat(req.get("X-Geo-Lng")),
      });
      toolBlock = toolCtx.block || "";
      // Matched saved documents (doc recall + client case files): show
      // them ON SCREEN while the reply is spoken. This event was the
      // missing half of voice recall — /chat returned documents but the
      // voice loop dropped them.
      if (Array.isArray(toolCtx.documents) && toolCtx.documents.length) {
        emit(s, { type: "documents", documents: toolCtx.documents.slice(0, 5) });
      }
    } catch (_) {}

    if (s.cancelled) return;

    // MULTI-AGENT routing. CONVERSATION turns stream sentence-by-
    // sentence (the app starts speaking sentence 1 while sentence 2 is
    // still generating — real-conversation latency). Specialist turns
    // (booking/search) do their tool work then reply whole, as before.
    const { route } = require("../agents/orchestrator");
    const agent = route(userText);
    const turnInput = {
      text: userText,
      history: s.history,
      userId: Number(s.userSub) > 0 ? Number(s.userSub) : null,
      tzOffsetMin: Number(req.get("X-TZ-Offset")) || 330,
      lat: parseFloat(req.get("X-Geo-Lat")),
      lng: parseFloat(req.get("X-Geo-Lng")),
      toolBlock,
    };

    let text;
    if (agent.name === "conversation") {
      const conversationAgent = require("../agents/conversationAgent");
      let firstSentence = true;
      const out = await conversationAgent.handleStream(turnInput, (sentence) => {
        if (s.cancelled) return;
        if (firstSentence) {
          firstSentence = false;
          state(s, "speaking"); // TTS starts NOW, not after the full reply
        }
        emit(s, { type: "assistant_sentence", text: sentence });
      });
      text = out.text || "Sorry, I couldn't answer that.";
      if (s.cancelled) return;
      s.history.push({ role: "assistant", content: text });
      // Final full text for the transcript; streamed:true tells the app
      // it has already spoken the sentences — display only, no re-speak.
      emit(s, { type: "assistant_message", text, streamed: true });
      state(s, "completed");
      s.busy = false;
      return;
    }

    const turn = await runAgentTurn(turnInput);
    if (s.cancelled) return;

    for (const u of turn.used) {
      emit(s, {
        type: "tool_started",
        tool: u.tool,
        label: `${turn.agentLabel} · ${u.label}`,
      });
      emit(s, { type: "tool_completed", tool: u.tool });
    }

    text = turn.text || "Sorry, I couldn't answer that.";
    s.history.push({ role: "assistant", content: text });

    state(s, "speaking"); // the app's TTS + avatar mouth run on this
    emit(s, { type: "assistant_message", text });
    state(s, "completed");
  } catch (e) {
    console.error("assistant turn failed:", e.message);
    emit(s, {
      type: "assistant_state",
      state: "error",
      message: "I hit a snag answering that. Please try again.",
    });
  } finally {
    s.busy = false;
  }
}

// POST /assistant/:sid/audio — the mic clip. STT then the normal turn.
router.post("/:sid/audio", upload.single("audio"), async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ error: "audio file required" });
  }
  res.status(202).json({ ok: true }); // events carry the real progress

  state(s, "transcribing");
  let text = "";
  try {
    const out = await transcribeAudio(
      req.file.buffer,
      req.file.mimetype || "audio/mp4"
    );
    text = String(out?.text || "").trim();
  } catch (e) {
    console.error("assistant stt failed:", e.message);
  }

  if (!text) {
    // Heard nothing usable — say so instead of leaving the app hanging
    // on "Transcribing…" forever (one of the reported symptoms).
    state(s, "speaking");
    emit(s, {
      type: "assistant_message",
      text: "Sorry, I couldn't hear that clearly. Could you say it again?",
    });
    state(s, "completed");
    return;
  }

  emit(s, { type: "user_transcript", text });
  await runTurn(s, req, text);
});

// POST /assistant/:sid/message — typed text path.
router.post("/:sid/message", async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  res.status(202).json({ ok: true });
  emit(s, { type: "user_transcript", text });
  await runTurn(s, req, text);
});

// POST /assistant/:sid/contacts — device-resolved matches for a lookup.
router.post("/:sid/contacts", (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const matches = Array.isArray(req.body?.matches) ? req.body.matches : [];
  const name = s.pendingContactName || "that contact";
  s.pendingContactName = null;
  res.json({ ok: true });

  if (matches.length === 0) {
    emit(s, { type: "contact_not_found" });
    state(s, "speaking");
    emit(s, {
      type: "assistant_message",
      text: `I couldn't find ${name} in your contacts.`,
    });
    state(s, "completed");
    s.pendingCallTask = null;
    return;
  }
  if (matches.length === 1) {
    // An agent-call task pending? Hari places the call itself and reports
    // back. Otherwise it's a plain direct-dial confirmation.
    if (s.pendingCallTask) return startAgentCall(s, matches[0], s.pendingCallTask, req);
    return askCallConfirm(s, matches[0]);
  }
  s.ambiguous = matches.slice(0, 6);
  emit(s, { type: "contacts_ambiguous", matches: s.ambiguous });
  state(s, "waiting_for_confirmation");
});

function askCallConfirm(s, contact) {
  s.pending = { action: "call", contact };
  emit(s, { type: "contact_found", contact });
  emit(s, {
    type: "confirmation_request",
    action: "call",
    contact,
    question: `Call ${contact.name}?`,
  });
  state(s, "waiting_for_confirmation");
}

// AGENT CALL — Hari phones [contact], speaks the [task] on the call, and
// reports the outcome back. Placed and polled server-side; the app just
// hears the narration and the result through the normal SSE events, so it
// needs no new UI. Auto-proceeds (the user asked for it); a "no answer"
// offers one retry via the normal confirmation card.
async function startAgentCall(s, contact, task, req) {
  try {
    s.pendingCallTask = null;
    const name = contact.name || "them";
    const number = contact.phone || contact.number || "";

    // Telephony not configured → fall back to a plain direct-dial so the
    // user's need is still met (they talk to the contact themselves).
    if (!agentCall.enabled() || !number) {
      emit(s, {
        type: "assistant_message",
        text: `I can't place that call myself on this setup, so I'll connect you to ${name} directly.`,
      });
      return askCallConfirm(s, contact);
    }

    emit(s, { type: "contact_found", contact });
    state(s, "speaking");
    emit(s, {
      type: "assistant_message",
      text: `Okay, calling ${name} now — I'll speak with them and tell you what happens.`,
    });

    let id;
    try {
      const out = await agentCall.start({
        userId: Number(s.userSub) > 0 ? Number(s.userSub) : null,
        userName: s.userName ? String(s.userName).split(" ")[0] : null,
        toNumber: number,
        contactName: name,
        task,
        lang: null,
      });
      id = out.id;
    } catch (e) {
      if (e?.code === "quota") {
        state(s, "speaking");
        emit(s, {
          type: "assistant_message",
          text: `You've reached today's limit for calls I place for you. I'll connect you to ${name} directly instead.`,
        });
        return askCallConfirm(s, contact);
      }
      state(s, "speaking");
      emit(s, {
        type: "assistant_message",
        text: `Sorry, I couldn't start the call to ${name} just now.`,
      });
      state(s, "completed");
      return;
    }

    emit(s, { type: "call_status", status: "dialing", contact_name: name });
    state(s, "in_call");

    // Poll the in-process call store until it reaches a terminal state.
    const deadline = Date.now() + 3 * 60 * 1000;
    let terminal = null;
    let result = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      if (s.cancelled) return;
      const st = agentCall.status(id);
      if (!st) break;
      if (st.state === "completed" || st.state === "no_answer" || st.state === "failed") {
        terminal = st.state;
        result = st.result;
        break;
      }
    }

    emit(s, { type: "call_status", status: terminal || "ended", contact_name: name });

    // No answer → offer ONE retry through the normal confirmation card.
    if (terminal === "no_answer" && (s.agentRetries || 0) < 1) {
      s.pending = { action: "agent_call_retry", contact, task };
      state(s, "speaking");
      emit(s, {
        type: "assistant_message",
        text: result || `${name} didn't pick up.`,
      });
      emit(s, {
        type: "confirmation_request",
        action: "agent_call_retry",
        contact,
        question: `Try calling ${name} again?`,
      });
      state(s, "waiting_for_confirmation");
      return;
    }

    state(s, "speaking");
    emit(s, {
      type: "assistant_message",
      text:
        result ||
        (terminal === "no_answer"
          ? `${name} still isn't picking up. I'll leave it for now.`
          : `I couldn't complete the call to ${name}.`),
    });
    s.history.push({
      role: "assistant",
      content: result || `Call to ${name} ended.`,
    });
    state(s, "completed");
  } catch (err) {
    console.error("startAgentCall error:", err.message || err);
    try {
      state(s, "speaking");
      emit(s, {
        type: "assistant_message",
        text: "Sorry, something went wrong with that call.",
      });
      state(s, "completed");
    } catch (_) {}
  }
}

// POST /assistant/:sid/choose — pick from the ambiguous list.
router.post("/:sid/choose", (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  res.json({ ok: true });
  const id = String(req.body?.contactId || "");
  // The app sends only the id — resolve it against the ambiguous list we
  // showed a moment ago.
  const chosen = (s.ambiguous || []).find((m) => String(m.id) === id);
  s.ambiguous = null;
  if (chosen) {
    if (s.pendingCallTask) return startAgentCall(s, chosen, s.pendingCallTask, req);
    return askCallConfirm(s, chosen);
  }
  state(s, "speaking");
  emit(s, {
    type: "assistant_message",
    text: "Sorry, I lost track of that choice. Please ask me again.",
  });
  state(s, "completed");
});

// POST /assistant/:sid/confirm — yes/no on the pending action.
router.post("/:sid/confirm", (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  res.json({ ok: true });
  const approved = req.body?.approved === true;
  const pending = s.pending;
  s.pending = null;

  if (!pending) {
    state(s, "completed");
    return;
  }
  if (!approved) {
    state(s, "speaking");
    emit(s, { type: "assistant_message", text: "Okay, cancelled." });
    state(s, "completed");
    return;
  }
  if (pending.action === "call") {
    // The APP places the call (it holds the phone + contact permissions);
    // these events drive its status UI while it does.
    emit(s, {
      type: "call_status",
      status: "dialing",
      contact_name: pending.contact?.name || "",
    });
    state(s, "in_call");
    state(s, "completed");
    return;
  }

  if (pending.action === "agent_call_retry") {
    // Retry a no-answer agent call. Bounded by s.agentRetries so it can't
    // loop. The reply already goes through startAgentCall's own narration.
    s.agentRetries = (s.agentRetries || 0) + 1;
    startAgentCall(s, pending.contact, pending.task, req);
    return;
  }
});

// POST /assistant/:sid/cancel — abort whatever is running.
router.post("/:sid/cancel", (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  s.cancelled = true;
  s.pending = null;
  s.pendingContactName = null;
  res.json({ ok: true });
  state(s, "idle");
});

module.exports = router;
module.exports.streamHandler = streamHandler;
