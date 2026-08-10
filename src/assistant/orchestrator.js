/**
 * ASSISTANT ORCHESTRATOR — the AI brain behind /assistant.
 *
 * Turn flow (all progress is pushed over the session's SSE stream):
 *
 *   user text/transcript
 *     -> thinking            (LLM w/ FUNCTION CALLING on Gemini; regex fallback)
 *        -> respond_to_user               : speak a direct reply
 *        -> search_web                    : searching -> results + spoken summary
 *        -> find_contact + place_call...  : finding_contact -> app resolves the
 *           name against DEVICE contacts (they live on the phone, not here),
 *           posts matches back -> waiting_for_confirmation -> user approves ->
 *           generating_voice (cloned voice if enrolled) -> dialing/ringing/
 *           in_call via Plivo -> completed
 *
 * The state machine states emitted here are EXACTLY the ones the Flutter
 * AssistantPhase enum renders: idle, listening, transcribing, thinking,
 * searching, finding_contact, preparing_message, generating_voice,
 * waiting_for_confirmation, dialing, ringing, in_call, speaking,
 * completed, error.
 */
const { search } = require("./search");
const tts = require("./tts");
const callStore = require("../agentcall/store");
const plivo = require("../agentcall/plivo");
const audit = require("../audit/log");
const { run, one } = require("../db");

const TIMEOUT_MS = 30_000;
const HISTORY_MAX = 16;

// ---------------- assistant settings (disclosure etc.) ----------------

let settingsTable = null;
function ensureSettings() {
  if (!settingsTable) {
    settingsTable = run(`
      CREATE TABLE IF NOT EXISTS assistant_settings (
        user_id              TEXT PRIMARY KEY,
        disclose_assistant   INT NOT NULL DEFAULT 1,
        require_confirmation INT NOT NULL DEFAULT 1
      )
    `);
  }
  return settingsTable;
}

async function getSettings(userId) {
  await ensureSettings();
  const row = await one("SELECT * FROM assistant_settings WHERE user_id = $1", [
    String(userId),
  ]);
  return {
    discloseAssistant: row ? !!row.disclose_assistant : true,
    requireConfirmation: row ? !!row.require_confirmation : true,
  };
}

async function setSettings(userId, patch) {
  await ensureSettings();
  const cur = await getSettings(userId);
  const next = {
    disclose:
      patch.discloseAssistant === undefined
        ? cur.discloseAssistant
        : !!patch.discloseAssistant,
    confirm:
      patch.requireConfirmation === undefined
        ? cur.requireConfirmation
        : !!patch.requireConfirmation,
  };
  await run(
    `INSERT INTO assistant_settings (user_id, disclose_assistant, require_confirmation)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       disclose_assistant = EXCLUDED.disclose_assistant,
       require_confirmation = EXCLUDED.require_confirmation`,
    [String(userId), next.disclose ? 1 : 0, next.confirm ? 1 : 0]
  );
  return getSettings(userId);
}

// ---------------- LLM with function calling ----------------

const SYSTEM_PROMPT =
  "You are a helpful, warm, concise voice-first personal assistant. " +
  "The user's message is a speech transcript — interpret mishearings " +
  "charitably. You MUST answer by calling exactly one tool. " +
  "For normal conversation call respond_to_user with a short spoken reply " +
  "(1-3 sentences, plain speech: no markdown, emojis or URLs). " +
  "When the user asks to look something up, find current information, or " +
  "says 'search for…', call search_web. " +
  "When the user asks to CALL someone and TELL/INFORM them something " +
  "(e.g. 'Call Alan and inform him I will not be coming today'), call " +
  "place_voice_call_with_message with the contact's name and the message " +
  "REWRITTEN in first person as the user would say it to that person " +
  "(e.g. 'I will not be coming today'). " +
  "Never invent phone numbers; the app resolves contacts on the device.";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "respond_to_user",
      description: "Reply to the user in normal conversation.",
      parameters: {
        type: "object",
        properties: {
          reply: { type: "string", description: "Short spoken reply." },
        },
        required: ["reply"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web for current information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "number" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_contact",
      description: "Look up a contact by name on the user's device.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "place_voice_call_with_message",
      description:
        "Call a contact and deliver a message on the user's behalf. " +
        "Use when the user asks to call someone and tell/inform them something.",
      parameters: {
        type: "object",
        properties: {
          contact_name: { type: "string", description: "Name as the user said it." },
          message: {
            type: "string",
            description: "The message in the user's first-person voice.",
          },
        },
        required: ["contact_name", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_confirmation",
      description:
        "Ask the user to approve something before acting. Use only when an " +
        "action is ambiguous or risky and none of the other tools fit.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
        },
        required: ["question"],
      },
    },
  },
];

/** One Gemini generation WITH function calling. Throws on any failure. */
async function llmDecide(history) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("gemini key missing");
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: history.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: String(m.content || "") }],
        })),
        // TOOLS is kept in OpenAI shape ({type:"function", function:{...}});
        // Gemini wants the inner object as a functionDeclaration.
        tools: [{ functionDeclarations: TOOLS.map((t) => t.function) }],
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig: { temperature: 0.4, maxOutputTokens: 600 },
      }),
    }
  );
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  const data = await r.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const fc = parts.find((p) => p.functionCall)?.functionCall;
  if (fc?.name) {
    // Gemini returns args as a ready object (no JSON string to parse).
    return { tool: fc.name, args: fc.args || {} };
  }
  // Model answered in plain text despite mode ANY — treat as a reply.
  const text = parts.map((p) => p.text || "").join("").trim();
  if (text) return { tool: "respond_to_user", args: { reply: text } };
  throw new Error("gemini: empty decision");
}

/**
 * Deterministic fallback when no AI key is set or the provider is down —
 * the three MVP intents still work end-to-end.
 */
function regexDecide(text) {
  const t = String(text).trim();
  // "call <name> and (inform|tell) (him|her|them)? (that)? <message>"
  const call =
    /^(?:please\s+)?call\s+([a-z][\w .'-]{0,60}?)\s+(?:and|to)\s+(?:inform|tell|let)\s+(?:him|her|them)?\s*(?:know)?\s*(?:that\s+)?(.+)$/i.exec(
      t
    );
  if (call) {
    return {
      tool: "place_voice_call_with_message",
      args: { contact_name: call[1].trim(), message: call[2].trim() },
    };
  }
  const searchM = /^(?:please\s+)?(?:search(?:\s+the\s+web)?(?:\s+for)?|look\s+up|find\s+out|google)\s+(.+)$/i.exec(
    t
  );
  if (searchM) return { tool: "search_web", args: { query: searchM[1].trim() } };
  return {
    tool: "respond_to_user",
    args: {
      reply:
        "Hello! I can chat, search the web, or call a contact and pass on a " +
        "message for you. What would you like?",
    },
  };
}

/** Plain-text LLM helper (summaries) with a safe fallback string. */
async function llmText(prompt, fallback) {
  try {
    const { generateReply } = require("../services/ai/router");
    const { reply } = await generateReply([{ role: "user", content: prompt }], {
      system:
        "You are a voice assistant. Reply with plain speech only — no " +
        "markdown, no emojis, no URLs. 1-3 short sentences.",
    });
    const out = String(reply || "").trim();
    return out || fallback;
  } catch (_) {
    return fallback;
  }
}

// ---------------- turn handling ----------------

/**
 * Entry point for a user turn (typed text or final transcript).
 * All output rides the SSE stream; the HTTP caller just gets 202.
 */
async function handleUserMessage(session, text, { userName } = {}) {
  const clean = String(text || "").trim().slice(0, 2000);
  if (!clean) return;
  session.cancelled = false;
  session.history.push({ role: "user", content: clean });
  if (session.history.length > HISTORY_MAX)
    session.history = session.history.slice(-HISTORY_MAX);

  session.emit({ type: "user_transcript", text: clean, final: true });
  session.setState("thinking");

  let decision;
  try {
    decision = await llmDecide(session.history);
  } catch (e) {
    console.warn("assistant: LLM decide failed —", e.message);
    decision = regexDecide(clean);
  }
  if (session.cancelled) return idle(session);

  try {
    switch (decision.tool) {
      case "search_web":
        return await doSearch(session, decision.args);
      case "find_contact":
      case "place_voice_call_with_message":
        return await startCallFlow(session, decision.args, { userName });
      case "request_confirmation":
        session.pending = { kind: "generic_confirm" };
        session.setState("waiting_for_confirmation");
        return session.emit({
          type: "confirmation_request",
          action: "generic",
          question: decision.args.question || "Shall I go ahead?",
        });
      case "respond_to_user":
      default:
        return await respond(session, decision.args.reply || "Okay.");
    }
  } catch (e) {
    console.error("assistant turn failed:", e);
    fail(session, "Something went wrong while handling that. Please try again.");
  }
}

async function respond(session, reply) {
  session.history.push({ role: "assistant", content: reply });
  session.emit({ type: "assistant_message", text: reply });
  session.setState("speaking");
  // The app returns to idle after its TTS finishes; also emit completed so
  // text-only clients settle.
  session.setState("completed");
}

function idle(session) {
  session.setState("idle");
}

function fail(session, message) {
  session.emit({ type: "error", message });
  session.setState("error", { message });
}

// ---------------- search flow ----------------

async function doSearch(session, { query, max_results }) {
  const q = String(query || "").trim();
  session.setState("searching");
  session.emit({
    type: "tool_started",
    tool: "search_web",
    label: `Searching the web for "${q}"`,
  });

  const { results, provider } = await search(q, max_results || 5);
  if (session.cancelled) return idle(session);

  session.emit({ type: "search_results", query: q, provider, results });
  session.emit({ type: "tool_completed", tool: "search_web" });

  session.setState("thinking");
  const context = results
    .map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`)
    .join("\n");
  const summary = await llmText(
    `The user asked: "${q}". Web search results:\n${context}\n\n` +
      `Give a concise spoken answer to the user's question based on these ` +
      `results (2-3 sentences, no source names, no URLs).`,
    results.length
      ? `Here's what I found about ${q}: ${results[0].title}.`
      : `I couldn't find results for ${q}.`
  );
  if (session.cancelled) return idle(session);
  session.history.push({ role: "assistant", content: summary });
  session.emit({ type: "assistant_message", text: summary });
  session.setState("speaking");
  session.setState("completed");
}

// ---------------- call-and-inform flow ----------------

/**
 * Step 1 — we know the intended name (maybe message too). Contacts live on
 * the DEVICE, so we ask the app to resolve the name and post matches back
 * to POST /assistant/:id/contacts. The pending record keeps the message.
 */
async function startCallFlow(session, { contact_name, name, message }, { userName }) {
  const who = String(contact_name || name || "").trim().slice(0, 80);
  const msg = String(message || "").trim().slice(0, 500);
  if (!who) {
    return respond(session, "Who would you like me to call?");
  }
  session.pending = { kind: "contact_lookup", name: who, message: msg, userName };
  session.setState("finding_contact");
  session.emit({
    type: "tool_started",
    tool: "find_contact",
    label: `Finding "${who}" in your contacts`,
  });
  session.emit({ type: "contact_lookup", name: who });
  // ...flow continues in onContactsResolved() when the app answers.
}

/**
 * Step 2 — the app answered with device-contact matches:
 *   matches: [{id, name, phone}]
 */
async function onContactsResolved(session, matches) {
  const p = session.pending;
  if (!p || (p.kind !== "contact_lookup" && p.kind !== "contact_choice")) return;
  const list = (Array.isArray(matches) ? matches : [])
    .filter((m) => m && m.phone)
    .slice(0, 8)
    .map((m) => ({
      id: String(m.id || m.phone).slice(0, 80),
      name: String(m.name || "Unknown").slice(0, 80),
      phone: String(m.phone).slice(0, 24),
    }));

  session.emit({ type: "tool_completed", tool: "find_contact" });

  if (list.length === 0) {
    session.pending = null;
    session.emit({ type: "contact_not_found", name: p.name });
    return respond(
      session,
      `I couldn't find ${p.name} in your contacts. You can try another name.`
    );
  }
  if (list.length > 1) {
    session.pending = { ...p, kind: "contact_choice", matches: list };
    session.emit({ type: "contacts_ambiguous", name: p.name, matches: list });
    session.setState("waiting_for_confirmation");
    return;
  }
  return prepareCall(session, list[0]);
}

/** The app tells us which of several matches the user tapped. */
async function onContactChosen(session, contactId) {
  const p = session.pending;
  if (!p || p.kind !== "contact_choice") return;
  const chosen = p.matches.find((m) => m.id === String(contactId));
  if (!chosen) return fail(session, "That contact choice wasn't recognized.");
  return prepareCall(session, chosen);
}

/** Step 3 — one contact locked in: build the summary + ask to confirm. */
async function prepareCall(session, contact) {
  const p = session.pending;
  session.pending = {
    ...p,
    kind: "confirm_call",
    contact,
  };
  session.emit({ type: "contact_found", contact });
  session.setState("preparing_message");

  const settings = await getSettings(session.userId);
  const disclosure = buildSpokenMessage({
    contactName: contact.name,
    userName: p.userName,
    message: p.message,
    disclose: settings.discloseAssistant,
    usesClonedVoice: Boolean(await tts.getProfile(session.userId).catch(() => null)),
  });
  session.pending.spoken = disclosure;

  session.setState("waiting_for_confirmation");
  session.emit({
    type: "confirmation_request",
    action: "place_call",
    contact,
    message: p.message,
    spoken_preview: disclosure,
  });
}

/**
 * What is actually SAID on the call. Disclosure is ON by default and
 * configurable via /assistant/settings (IMPORTANT: when the user's cloned
 * voice is used, the assistant identifies itself and the voice).
 */
function buildSpokenMessage({ contactName, userName, message, disclose, usesClonedVoice }) {
  const user = userName || "your contact";
  const first = String(contactName || "").split(/\s+/)[0];
  const msg = message || "";
  if (!disclose) return `Hi ${first}. ${msg}`;
  if (usesClonedVoice) {
    return (
      `Hi ${first}, this is ${user}'s AI assistant, using ${user}'s voice. ` +
      `They asked me to tell you: ${msg}`
    );
  }
  return (
    `Hi ${first}, this is ${user}'s AI assistant, calling on their behalf. ` +
    `They asked me to inform you that ${msg}`
  );
}

/** Step 4 — user tapped Confirm (or Cancel). */
async function onConfirm(session, approved, { userName } = {}) {
  const p = session.pending;
  if (!p) return;
  session.pending = null;

  if (p.kind === "generic_confirm") {
    return respond(session, approved ? "Okay, going ahead." : "Okay, cancelled.");
  }
  if (p.kind !== "confirm_call") return;
  if (!approved) {
    return respond(session, "Okay, I won't make that call.");
  }

  const { contact, spoken } = p;

  // Cloned/standard TTS audio for the call opening — the app also gets an
  // audio_ready event so the user can hear exactly what will be said.
  session.setState("generating_voice");
  let audio = null;
  try {
    audio = await tts.synthesize(session.userId, spoken);
  } catch (e) {
    console.warn("assistant: TTS failed, falling back to carrier TTS —", e.message);
  }
  if (audio) {
    session.emit({
      type: "audio_ready",
      url: audio.url,
      cloned_voice: audio.usedClonedVoice,
    });
  }
  if (session.cancelled) return idle(session);

  if (!plivo.configured()) {
    // No telephony credentials: simulate the call locally so the whole UX
    // is testable. Clearly labelled as a simulation.
    return simulateCall(session, contact, spoken);
  }

  const to = plivo.toE164(contact.phone);
  if (!to) return fail(session, `${contact.name}'s number doesn't look valid.`);

  const call = await callStore.create({
    userId: session.userId,
    contactName: contact.name,
    toNumber: to,
    task: `Deliver this message and nothing else: "${spoken}". After delivering it, briefly acknowledge any short reply and say goodbye.`,
    lang: "en-IN",
  });
  if (audio) {
    await run("UPDATE agent_calls SET opening_audio_url = $1 WHERE id = $2", [
      audio.url,
      call.id,
    ]).catch(() => {});
  }

  try {
    const uuid = await plivo.createCall({ to, callId: call.id });
    await callStore.setProviderId(call.id, uuid);
    await callStore.setState(call.id, "dialing");
    audit.record(session.userId, "call.placed", `inform ${contact.name}`);
  } catch (e) {
    console.error("assistant: place call failed —", e.message);
    await callStore.setResult(call.id, null, "failed");
    return fail(session, `I couldn't reach the phone network to call ${contact.name}.`);
  }

  session.activeCallId = call.id;
  session.setState("dialing");
  session.emit({ type: "call_status", status: "dialing", contact_name: contact.name });
  watchCall(session, call.id, contact.name);
}

/** Poll the agent_calls row (Plivo webhooks update it) → SSE call_status. */
function watchCall(session, callId, contactName) {
  let last = "dialing";
  const started = Date.now();
  const timer = setInterval(async () => {
    if (session.cancelled || session.activeCallId !== callId) {
      return clearInterval(timer);
    }
    let call;
    try {
      call = await callStore.get(callId);
    } catch (_) {
      return; // transient DB blip; try again next tick
    }
    if (!call) return clearInterval(timer);

    const map = {
      queued: "dialing",
      dialing: "ringing",
      in_progress: "in_call",
      completed: "completed",
      failed: "failed",
      no_answer: "no_answer",
    };
    const status = map[call.state] || call.state;
    if (status !== last) {
      last = status;
      const uiState =
        status === "ringing" ? "ringing" : status === "in_call" ? "in_call" : null;
      if (uiState) session.setState(uiState);
      session.emit({ type: "call_status", status, contact_name: contactName });
    }
    const done = ["completed", "failed", "no_answer"].includes(call.state);
    if (done || Date.now() - started > 6 * 60_000) {
      clearInterval(timer);
      session.activeCallId = null;
      if (call.state === "completed") {
        const report =
          call.result || `Done — I called ${contactName} and passed on your message.`;
        session.history.push({ role: "assistant", content: report });
        session.emit({ type: "assistant_message", text: report });
        session.setState("completed");
      } else if (call.state === "no_answer") {
        session.emit({ type: "call_status", status: "no_answer", contact_name: contactName });
        respond(session, `${contactName} didn't pick up. Want me to try again later?`);
      } else {
        fail(session, `The call to ${contactName} didn't go through.`);
      }
    }
  }, 2000);
  timer.unref?.();
}

/** Dev-mode pretend call — full state choreography, no telephony. */
function simulateCall(session, contact, spoken) {
  const name = contact.name;
  const steps = [
    ["dialing", 400],
    ["ringing", 1500],
    ["in_call", 2500],
  ];
  session.emit({
    type: "assistant_message",
    text: `(Simulation — set PLIVO_* env vars for real calls.)`,
  });
  let delay = 0;
  for (const [status, wait] of steps) {
    delay += wait;
    setTimeout(() => {
      if (session.cancelled) return;
      session.setState(status === "dialing" ? "dialing" : status);
      session.emit({ type: "call_status", status, contact_name: name });
    }, delay);
  }
  setTimeout(() => {
    if (session.cancelled) return;
    session.emit({ type: "call_status", status: "completed", contact_name: name });
    const report = `Done — I called ${name} and said: "${spoken}"`;
    session.history.push({ role: "assistant", content: report });
    session.emit({ type: "assistant_message", text: report });
    session.setState("completed");
  }, delay + 3000);
}

/** User hit cancel: stop whatever is in flight (calls in progress excepted). */
function cancel(session) {
  session.cancelled = true;
  session.pending = null;
  session.emit({ type: "assistant_message", text: "Okay, cancelled." });
  session.setState("idle");
}

module.exports = {
  handleUserMessage,
  onContactsResolved,
  onContactChosen,
  onConfirm,
  cancel,
  getSettings,
  setSettings,
};
