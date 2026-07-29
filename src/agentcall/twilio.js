/**
 * TWILIO — thin REST client (no SDK; one fetch call) + webhook security.
 *
 * Env:
 *   TWILIO_ACCOUNT_SID   ACxxxxxxxx…
 *   TWILIO_AUTH_TOKEN    webhook signature secret + API password
 *   TWILIO_FROM_NUMBER   your Twilio number, E.164 (+1…, +91…)
 *   PUBLIC_BASE_URL      https URL of THIS server (webhooks call back here)
 *   TWILIO_VALIDATE      "false" to skip signature checks (dev tunnels only)
 *   DEFAULT_COUNTRY_CODE numeric, default 91 (India) — used to normalize
 *                        10-digit local numbers to E.164
 */
const crypto = require("crypto");

const sid = () => process.env.TWILIO_ACCOUNT_SID || "";
const token = () => process.env.TWILIO_AUTH_TOKEN || "";
const from = () => process.env.TWILIO_FROM_NUMBER || "";
const baseUrl = () => (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

function configured() {
  return Boolean(sid() && token() && from() && baseUrl());
}

/** "98765 43210" / "098765-43210" / "+91 98765 43210" → "+919876543210". */
function toE164(raw) {
  let n = String(raw || "").replace(/[^\d+]/g, "");
  if (!n) return null;
  if (n.startsWith("+")) n = "+" + n.slice(1).replace(/\D/g, "");
  else {
    n = n.replace(/^0+/, "");
    const cc = (process.env.DEFAULT_COUNTRY_CODE || "91").replace(/\D/g, "");
    // Already includes the country code? (e.g. "919876543210")
    if (!(n.length > 10 && n.startsWith(cc))) n = cc + n;
    n = "+" + n;
  }
  return /^\+\d{8,15}$/.test(n) ? n : null;
}

/**
 * Places the outbound call. Twilio will request TwiML from our /voice
 * webhook and report lifecycle events to /status.
 * @returns Twilio call SID
 */
async function createCall({ to, callId }) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid()}/Calls.json`;
  const cb = `${baseUrl()}/agent-call/twilio/${callId}`;
  const body = new URLSearchParams({
    To: to,
    From: from(),
    Url: `${cb}/voice`,
    Method: "POST",
    StatusCallback: `${cb}/status`,
    StatusCallbackMethod: "POST",
    // Ringing forever wastes the user's wait — give up after 30 s.
    Timeout: "30",
    // If voicemail answers, Twilio detects it and we treat it as no-answer.
    MachineDetection: "Enable",
  });
  const r = await fetch(url, {
    method: "POST",
    headers: {
      authorization:
        "Basic " + Buffer.from(`${sid()}:${token()}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
    },
    signal: AbortSignal.timeout(15_000),
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`twilio ${r.status}: ${data.message || "call failed"}`);
  }
  return data.sid;
}

/** Best-effort hangup (fire and forget on cancel/timeout paths). */
async function hangup(callSid) {
  try {
    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid()}/Calls/${callSid}.json`,
      {
        method: "POST",
        headers: {
          authorization:
            "Basic " + Buffer.from(`${sid()}:${token()}`).toString("base64"),
          "content-type": "application/x-www-form-urlencoded",
        },
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ Status: "completed" }),
      }
    );
  } catch (_) {}
}

/**
 * Twilio webhook signature check (X-Twilio-Signature): HMAC-SHA1 of
 * (full URL + POST params concatenated key+value in sorted key order),
 * base64, keyed by the auth token. Rejecting bad signatures is what
 * stops strangers from injecting fake "the contact said…" turns.
 */
function validSignature(req) {
  if (process.env.TWILIO_VALIDATE === "false") return true;
  const sig = req.get("X-Twilio-Signature") || "";
  if (!sig) return false;
  const url = baseUrl() + req.originalUrl;
  let data = url;
  const params = req.body || {};
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const expected = crypto
    .createHmac("sha1", token())
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (_) {
    return false;
  }
}

// ---------------- TwiML ----------------

const esc = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Language → a natural Twilio TTS voice (Polly neural where available). */
function voiceFor(lang) {
  const l = String(lang || "en-IN").toLowerCase();
  if (l.startsWith("hi")) return { voice: "Polly.Kajal-Neural", language: "hi-IN" };
  if (l.startsWith("en-in") || l === "en") return { voice: "Polly.Kajal-Neural", language: "en-IN" };
  if (l.startsWith("en")) return { voice: "Polly.Joanna-Neural", language: "en-US" };
  // Other Indic languages: Twilio's basic engine handles them; keep the code.
  return { voice: "alice", language: lang };
}

/** Speak [text], then listen for the contact's spoken reply. */
function twimlSayGather({ text, actionUrl, lang }) {
  const v = voiceFor(lang);
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say voice="${esc(v.voice)}" language="${esc(v.language)}">${esc(text)}</Say>` +
    `<Gather input="speech" action="${esc(actionUrl)}" method="POST" ` +
    `language="${esc(v.language)}" speechTimeout="auto" timeout="6" ` +
    `speechModel="deepgram_nova-2" actionOnEmptyResult="true"/>` +
    `</Response>`
  );
}

/** Speak [text] and hang up. */
function twimlSayHangup({ text, lang }) {
  const v = voiceFor(lang);
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say voice="${esc(v.voice)}" language="${esc(v.language)}">${esc(text)}</Say>` +
    `<Hangup/></Response>`
  );
}

module.exports = {
  configured,
  toE164,
  createCall,
  hangup,
  validSignature,
  twimlSayGather,
  twimlSayHangup,
};
