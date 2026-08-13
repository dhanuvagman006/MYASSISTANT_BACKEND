/**
 * AGENT CALLS — Hari phones the user's contact, delivers or asks something
 * on the user's behalf, and hangs up on its own.
 *
 * "Call mom and tell her I'll be late"  -> Hari dials mom, speaks the message
 *                                          in a natural voice, and ends the
 *                                          call automatically.
 * "Call the clinic and ask when I can come in" -> Hari asks, captures the
 *                                          spoken reply, and reports it back.
 *
 * Telephony provider: PLIVO (India-capable, per-minute, simple XML control).
 * The phone's own dialer is never used, so the app's voice loop keeps running
 * while the call happens and speaks the outcome the moment it lands.
 *
 * Flow:
 *   1. app POST /agent-call            -> we place a Plivo call, return {id}
 *   2. Plivo answers  -> GET/POST /agent-call/plivo/:id/:token/answer
 *                        we return Plivo XML: speak the message; for an
 *                        "ask" task, gather the reply; then hang up.
 *   3. reply captured  -> /agent-call/plivo/:id/:token/gather
 *   4. call ends       -> /agent-call/plivo/:id/:token/hangup (status)
 *   5. app polls GET /agent-call/:id until a terminal state, then speaks
 *      `result`.
 *
 * Env (feature hidden — returns 503 — while unset, so the app falls back to
 * a normal direct dial):
 *   PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN   from console.plivo.com
 *   PLIVO_FROM_NUMBER                 a Plivo voice-enabled number (E.164)
 *   PUBLIC_BASE_URL                   https URL Plivo can reach for webhooks
 *   PLIVO_VOICE                       optional, default "Polly.Aditi"
 *   AGENT_CALL_DAILY_LIMIT            optional, default 20 calls/user/day
 */

const crypto = require("crypto");
const { generateReply } = require("../services/ai/router");

const PLIVO_BASE = "https://api.plivo.com/v1";

function cfg() {
  return {
    authId: process.env.PLIVO_AUTH_ID || "",
    authToken: process.env.PLIVO_AUTH_TOKEN || "",
    from: process.env.PLIVO_FROM_NUMBER || "",
    base: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    voice: process.env.PLIVO_VOICE || "Polly.Aditi",
    dailyLimit: Number(process.env.AGENT_CALL_DAILY_LIMIT || 20),
  };
}

/** The feature is available only when telephony + a reachable base URL exist. */
function enabled() {
  const c = cfg();
  return Boolean(c.authId && c.authToken && c.from && c.base);
}

// ---------------- IN-MEMORY CALL STORE ----------------
// Agent calls are short-lived (< 3 min). A Map with TTL cleanup is plenty;
// move to Postgres later if cross-restart durability is ever needed.

const calls = new Map(); // id -> record
const CALL_TTL_MS = 15 * 60 * 1000;

function gc() {
  const now = Date.now();
  for (const [id, c] of calls) {
    if (now - c.createdAt > CALL_TTL_MS) calls.delete(id);
  }
}
setInterval(gc, 5 * 60 * 1000).unref?.();

// Per-user daily counter (resets by date string).
const dayCounts = new Map(); // `${userId}:${yyyy-mm-dd}` -> n
function bumpDaily(userId) {
  const key = `${userId}:${new Date().toISOString().slice(0, 10)}`;
  const n = (dayCounts.get(key) || 0) + 1;
  dayCounts.set(key, n);
  return n;
}
function dailyCount(userId) {
  const key = `${userId}:${new Date().toISOString().slice(0, 10)}`;
  return dayCounts.get(key) || 0;
}

// ---------------- LANGUAGE / VOICE ----------------

// Plivo <Speak> uses an Amazon Polly voice (namespaced "Polly."). Aditi is
// bilingual Indian-English + Hindi, a natural default for India; the voice
// itself carries the language, so <Speak> takes NO language attribute. The
// ASR language (for GetInput speech recognition) is returned separately.
function voiceFor(lang) {
  const c = cfg();
  const l = String(lang || "en").toLowerCase().slice(0, 2);
  const asr = {
    hi: "hi-IN", en: "en-IN", ta: "ta-IN", te: "te-IN",
    kn: "kn-IN", ml: "ml-IN", bn: "bn-IN", mr: "mr-IN",
  }[l] || "en-IN";
  return { voice: c.voice, asrLang: asr };
}

// ---------------- TASK MODE + SCRIPT ----------------

// "ask / find out / when / what time" => two-way; otherwise a one-way notice.
const ASK_RX =
  /\b(ask|find out|check|confirm|whether|when|what time|what|how|is (he|she|it|they)|are (they|you)|can (you|he|she|they)|will (he|she|they)|did (he|she|they))\b/i;

function detectMode(task) {
  return ASK_RX.test(String(task || "")) ? "ask" : "inform";
}

/**
 * Generate the natural spoken script for the call. Returns
 * { mode, speech, closing } — `speech` is the main line (the message to
 * deliver, or the question to ask); `closing` is a short sign-off.
 */
async function buildScript({ userName, contactName, task, lang }) {
  const mode = detectMode(task);
  const who = userName ? userName : "the caller";
  const sys =
    "You write a SHORT phone script for an AI assistant that is calling " +
    "someone ON BEHALF OF a user. You are the assistant speaking to the " +
    "CONTACT (not to the user). Be warm, brief and natural — this is spoken " +
    "aloud on a phone call. Identify yourself in one clause as calling on " +
    `${who}'s behalf. ` +
    (mode === "ask"
      ? "The user wants you to ASK the contact something and get their answer. "
      : "The user wants you to INFORM the contact of something; do not ask a question. ") +
    "Reply with STRICT JSON only, no markdown: " +
    '{"speech":"<the main thing you say>","closing":"<a short sign-off>"}. ' +
    "Keep speech to 1-2 sentences. Use ONLY the language of code " +
    `"${(lang || "en").slice(0, 2)}" (fallback to simple English). ` +
    "Never invent details the user did not give.";
  const user =
    `User's name: ${who}. Contact's name: ${contactName}. ` +
    `What the user asked me to do: "${task}".`;

  try {
    const { reply } = await generateReply(
      [{ role: "user", content: user }],
      { system: sys }
    );
    const parsed = JSON.parse(stripFences(reply));
    const speech = String(parsed.speech || "").trim();
    const closing =
      String(parsed.closing || "").trim() || defaultClosing(lang);
    if (speech) return { mode, speech, closing };
  } catch (_) {
    /* fall through to a safe template */
  }
  // Safe fallback template if the model misbehaves.
  const hi = /^hi/i.test(lang || "");
  if (mode === "ask") {
    return {
      mode,
      speech: hi
        ? `नमस्ते, मैं ${who} की ओर से बात कर रहा हूँ। ${task}`
        : `Hello, I'm calling on behalf of ${who}. ${task}`,
      closing: defaultClosing(lang),
    };
  }
  return {
    mode,
    speech: hi
      ? `नमस्ते, मैं ${who} की ओर से एक संदेश दे रहा हूँ। ${task}`
      : `Hello, I'm calling on behalf of ${who} with a message. ${task}`,
    closing: defaultClosing(lang),
  };
}

function defaultClosing(lang) {
  return /^hi/i.test(lang || "") ? "धन्यवाद, अलविदा।" : "Thank you, goodbye.";
}

function stripFences(s) {
  return String(s || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

// ---------------- RESULT SUMMARY (spoken back to the user) ----------------

/**
 * Turn the contact's raw spoken reply into a clean first-person report for
 * the user, in the user's language.
 */
async function summarizeAnswer({ contactName, task, answer, lang }) {
  const raw = String(answer || "").trim();
  if (!raw) {
    return `I spoke with ${contactName}, but couldn't make out their reply clearly.`;
  }
  const sys =
    "You are reporting back to a user what their contact said on a phone " +
    "call you just made for them. Write ONE or TWO short spoken sentences, " +
    "first person ('I asked … they said …'). Use ONLY the language of code " +
    `"${(lang || "en").slice(0, 2)}" (fallback to simple English). No markdown.`;
  const user =
    `Contact: ${contactName}. What I was asked to do: "${task}". ` +
    `What the contact said (raw transcript): "${raw}".`;
  try {
    const { reply } = await generateReply(
      [{ role: "user", content: user }],
      { system: sys }
    );
    const out = String(reply || "").trim();
    if (out) return out;
  } catch (_) {}
  return `I spoke with ${contactName}. They said: ${raw}`;
}

// ---------------- PLIVO ----------------

function xmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function plivoPlaceCall({ to, id, token }) {
  const c = cfg();
  const answerUrl = `${c.base}/agent-call/plivo/${id}/${token}/answer`;
  const hangupUrl = `${c.base}/agent-call/plivo/${id}/${token}/hangup`;
  const auth = Buffer.from(`${c.authId}:${c.authToken}`).toString("base64");

  const r = await fetch(`${PLIVO_BASE}/Account/${c.authId}/Call/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${auth}`,
    },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      from: c.from,
      to,
      answer_url: answerUrl,
      answer_method: "POST",
      hangup_url: hangupUrl,
      hangup_method: "POST",
      ring_timeout: 30,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`plivo ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.request_uuid || null;
}

// ---------------- PUBLIC API (used by routes) ----------------

/** Preview: the opening line + a verdict on the user's call rules. */
async function preview({ userName, contactName, task, lang }) {
  const script = await buildScript({ userName, contactName, task, lang });
  return { opening: script.speech, allowed: true, reason: null, mode: script.mode };
}

/**
 * Place an agent call. Returns { id } (202). Throws { code:"unavailable" }
 * when telephony isn't configured, or { code:"quota" } over the daily limit.
 */
async function start({ userId, userName, toNumber, contactName, task, lang }) {
  if (!enabled()) throw { code: "unavailable" };
  const to = normalizeNumber(toNumber);
  if (!to) throw { code: "bad_number" };

  const c = cfg();
  if (userId && dailyCount(userId) >= c.dailyLimit) {
    throw { code: "quota" };
  }

  const id = crypto.randomBytes(12).toString("hex");
  const token = crypto.randomBytes(8).toString("hex");
  const script = await buildScript({ userName, contactName, task, lang });

  const rec = {
    id,
    token,
    userId: userId || null,
    to,
    contactName,
    task,
    lang: lang || "en",
    mode: script.mode,
    script,
    state: "dialing",
    result: null,
    answer: null,
    plivoUuid: null,
    createdAt: Date.now(),
  };
  calls.set(id, rec);

  try {
    rec.plivoUuid = await plivoPlaceCall({ to, id, token });
    if (userId) bumpDaily(userId);
  } catch (e) {
    rec.state = "failed";
    rec.result = `I couldn't start the call to ${contactName} just now.`;
    throw { code: "failed", message: String(e.message || e) };
  }
  return { id };
}

/** Poll status for the app. */
function status(id) {
  const rec = calls.get(id);
  if (!rec) return null;
  return { state: rec.state, result: rec.result };
}

// ---------------- WEBHOOK HANDLERS (called by Plivo) ----------------

function get(id, token) {
  const rec = calls.get(id);
  if (!rec || rec.token !== token) return null;
  return rec;
}

/** Build the answer XML: speak the message, gather a reply if asking, hang up. */
function answerXml(rec) {
  const c = cfg();
  const v = voiceFor(rec.lang);
  const speakOpen = `<Speak voice="${v.voice}">`;
  const speech = xmlEscape(rec.script.speech);
  const closing = xmlEscape(rec.script.closing);

  if (rec.state === "dialing") rec.state = "in_progress";

  if (rec.mode === "ask") {
    const action = `${c.base}/agent-call/plivo/${rec.id}/${rec.token}/gather`;
    // Speak the question inside GetInput; capture the spoken reply. If no
    // reply is heard, a short retry line plays, then we hang up.
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response>` +
      `<GetInput inputType="speech" action="${action}" method="POST" ` +
      `speechEndTimeout="auto" language="${v.asrLang}">` +
      `${speakOpen}${speech}</Speak>` +
      `</GetInput>` +
      `${speakOpen}${closing}</Speak>` +
      `<Hangup/>` +
      `</Response>`
    );
  }

  // INFORM: deliver the message and hang up — the call cuts itself.
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `${speakOpen}${speech}</Speak>` +
    `${speakOpen}${closing}</Speak>` +
    `<Hangup/>` +
    `</Response>`
  );
}

/** GetInput action: the contact's reply arrived. Store + finalize. */
async function onGather(rec, params) {
  const spoken = String(params.Speech || params.SpeechResult || "").trim();
  rec.answer = spoken;
  rec.state = "summarizing";
  const v = voiceFor(rec.lang);
  const speakOpen = `<Speak voice="${v.voice}">`;

  // Finalize the user-facing result off the critical path.
  rec.result = await summarizeAnswer({
    contactName: rec.contactName,
    task: rec.task,
    answer: spoken,
    lang: rec.lang,
  });
  rec.state = "completed";

  // Say thanks and hang up.
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `${speakOpen}${xmlEscape(rec.script.closing)}</Speak>` +
    `<Hangup/>` +
    `</Response>`
  );
}

/** Hangup/status callback: mark terminal state if not already resolved. */
function onHangup(rec, params) {
  const callStatus = String(params.CallStatus || params.Status || "").toLowerCase();
  const hangupCause = String(params.HangupCause || "").toLowerCase();

  if (rec.state === "completed") return; // already resolved by gather

  if (rec.mode === "inform" && (rec.state === "in_progress")) {
    // The message was delivered and the call ended normally.
    rec.state = "completed";
    rec.result =
      rec.result || `Done — I let ${rec.contactName} know: ${rec.script.speech}`;
    return;
  }

  // Never answered / busy / failed before we spoke.
  const noAnswer =
    callStatus.includes("no-answer") ||
    callStatus.includes("noanswer") ||
    callStatus.includes("busy") ||
    hangupCause.includes("no_answer") ||
    hangupCause.includes("busy") ||
    hangupCause.includes("timeout") ||
    rec.state === "dialing";

  if (noAnswer) {
    rec.state = "no_answer";
    rec.result = `${rec.contactName} didn't pick up. Want me to try again later?`;
  } else if (rec.mode === "ask" && !rec.answer) {
    // Answered but hung up before replying.
    rec.state = "completed";
    rec.result = `I reached ${rec.contactName}, but they hung up before answering.`;
  } else {
    rec.state = rec.state === "summarizing" ? "completed" : "failed";
    rec.result =
      rec.result || `I couldn't complete the call to ${rec.contactName}.`;
  }
}

// ---------------- HELPERS ----------------

function normalizeNumber(n) {
  const s = String(n || "").replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) return s;
  // Bare 10-digit Indian mobile -> +91. Otherwise leave as-is with a +.
  if (/^\d{10}$/.test(s)) return `+91${s}`;
  return `+${s}`;
}

module.exports = {
  enabled,
  preview,
  start,
  status,
  get,
  answerXml,
  onGather,
  onHangup,
};
