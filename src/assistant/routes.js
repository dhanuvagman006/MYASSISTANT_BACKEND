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

const {
  generateReply,
  transcribeAudio,
} = require("../services/ai/router");
const { buildToolContext } = require("../services/intents");

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

function newSession(userSub) {
  const sid = crypto.randomUUID();
  const s = {
    sid,
    userSub: userSub || null,
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
  const s = newSession(req.user?.sub);
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
    // "Call amma" — contacts live on the DEVICE, so ask the app to
    // resolve the name; the flow continues in /contacts below.
    const callee = detectCallIntent(userText);
    if (callee) {
      s.pendingContactName = callee;
      state(s, "finding_contact");
      emit(s, { type: "contact_lookup", name: callee });
      return; // waits for POST /contacts
    }

    state(s, "thinking");
    s.history.push({ role: "user", content: userText.slice(0, 8000) });
    if (s.history.length > 20) s.history = s.history.slice(-20);

    // Same tool layer the /chat route uses — reminders, weather, news,
    // documents… so the voice assistant knows everything chat knows.
    let extraSystem = "";
    let toolCtx = null;
    try {
      toolCtx = await buildToolContext({
        userId: Number(s.userSub) > 0 ? Number(s.userSub) : null,
        messages: s.history,
        tzOffsetMin: Number(req.get("X-TZ-Offset")) || 330,
        lat: parseFloat(req.get("X-Geo-Lat")),
        lng: parseFloat(req.get("X-Geo-Lng")),
      });
      extraSystem = toolCtx.block || "";
      for (const src of toolCtx.sources || []) {
        emit(s, { type: "tool_started", tool: src, label: `Using ${src}…` });
        emit(s, { type: "tool_completed", tool: src });
      }
    } catch (_) {}

    if (s.cancelled) return;
    const { reply } = await generateReply(s.history, { extraSystem });
    if (s.cancelled) return;

    const text = reply || "Sorry, I couldn't answer that.";
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
    return;
  }
  if (matches.length === 1) return askCallConfirm(s, matches[0]);
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
  if (chosen) return askCallConfirm(s, chosen);
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
