/**
 * PLIVO — India-capable telephony (replaces Twilio).
 *
 * Why Plivo: it rents REAL Indian (+91) numbers with domestic routing
 * (business KYC required, ~1 day), so contacts see a local caller ID
 * and calls stay on Indian trunks (TRAI media-anchoring compliant).
 * Until KYC is approved, the same account calls India over
 * international routes — the code path is identical.
 *
 * SDK-free: one REST call to place the call, XML webhooks for the
 * conversation (Speak = TTS out, GetInput speech = contact's words in).
 *
 * Env:
 *   PLIVO_AUTH_ID        MAxxxxxxxxxxxxxxxxxx
 *   PLIVO_AUTH_TOKEN     webhook signature secret + API password
 *   PLIVO_FROM_NUMBER    your Plivo number, E.164 (+91… once KYC'd)
 *   PUBLIC_BASE_URL      https URL of THIS server (webhooks call back here)
 *   PLIVO_VALIDATE       "false" to skip signature checks (dev tunnels only)
 *   DEFAULT_COUNTRY_CODE numeric, default 91 — normalizes 10-digit local
 *                        numbers to E.164
 */
const crypto = require("crypto");

const authId = () => process.env.PLIVO_AUTH_ID || "";
const token = () => process.env.PLIVO_AUTH_TOKEN || "";
const from = () => process.env.PLIVO_FROM_NUMBER || "";
const baseUrl = () => (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

function configured() {
  return Boolean(authId() && token() && from() && baseUrl());
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

const apiAuth = () =>
  "Basic " + Buffer.from(`${authId()}:${token()}`).toString("base64");

/**
 * Places the outbound call. Plivo fetches XML from our /answer webhook
 * when the contact picks up and reports the end on /hangup.
 * machine_detection=hangup: voicemail answers → Plivo hangs up, our
 * /hangup webhook sees the machine cause and marks no_answer.
 * @returns Plivo request UUID
 */
async function createCall({ to, callId }) {
  const cb = `${baseUrl()}/agent-call/plivo/${callId}`;
  const r = await fetch(
    `https://api.plivo.com/v1/Account/${authId()}/Call/`,
    {
      method: "POST",
      headers: { authorization: apiAuth(), "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        to: to.replace(/^\+/, ""), // Plivo wants digits without '+'
        from: from().replace(/^\+/, ""),
        answer_url: `${cb}/answer`,
        answer_method: "POST",
        hangup_url: `${cb}/hangup`,
        hangup_method: "POST",
        // Ringing forever wastes the user's wait — give up after 30 s.
        ring_timeout: 30,
        machine_detection: "hangup",
        machine_detection_time: 5000,
      }),
    }
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`plivo ${r.status}: ${data.error || "call failed"}`);
  }
  return data.request_uuid || (data.request_uuid === 0 ? "0" : data.request_uuid);
}

/** Best-effort hangup of a live call (cancel/timeout paths). */
async function hangup(callUuid) {
  if (!callUuid) return;
  try {
    await fetch(
      `https://api.plivo.com/v1/Account/${authId()}/Call/${callUuid}/`,
      {
        method: "DELETE",
        headers: { authorization: apiAuth() },
        signal: AbortSignal.timeout(10_000),
      }
    );
  } catch (_) {}
}

/**
 * Plivo webhook signature (V2): base64(HMAC-SHA256(auth_token,
 * webhook_url + nonce)). Headers: X-Plivo-Signature-V2 (may list several,
 * comma-separated, when the token was rotated) + X-Plivo-Signature-V2-Nonce.
 * Rejecting bad signatures is what stops strangers from injecting fake
 * "the contact said…" turns into a live call.
 */
function validSignature(req) {
  if (process.env.PLIVO_VALIDATE === "false") return true;
  const nonce = req.get("X-Plivo-Signature-V2-Nonce") || "";
  const sigs = (req.get("X-Plivo-Signature-V2") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!nonce || sigs.length === 0) return false;
  const url = baseUrl() + req.originalUrl;
  const expected = crypto
    .createHmac("sha256", token())
    .update(Buffer.from(url + nonce, "utf-8"))
    .digest("base64");
  return sigs.some((s) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected));
    } catch (_) {
      return false;
    }
  });
}

// ---------------- Plivo XML ----------------

const esc = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Language → a natural Plivo/Polly TTS voice. */
function voiceFor(lang) {
  const l = String(lang || "en-IN").toLowerCase();
  if (l.startsWith("hi") || l.startsWith("en-in") || l === "en") {
    return { voice: "Polly.Aditi", language: l.startsWith("hi") ? "hi-IN" : "en-IN" };
  }
  if (l.startsWith("en")) return { voice: "Polly.Joanna", language: "en-US" };
  // Other Indic languages: Plivo's base engine; keep the requested code
  // for ASR so the contact can answer in their own language.
  return { voice: "WOMAN", language: lang };
}

/** Speak [text] while listening for the contact's spoken reply (the
 *  prompt is nested inside GetInput so the contact can start answering
 *  over it). Silence falls through GetInput to the Redirect, so the
 *  action handler is reached either way (with or without Speech). */
function xmlSpeakGetInput({ text, actionUrl, lang }) {
  const v = voiceFor(lang);
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<GetInput action="${esc(actionUrl)}" method="POST" inputType="speech" ` +
    `language="${esc(v.language)}" speechEndTimeout="3" executionTimeout="15" ` +
    `redirect="true" profanityFilter="false">` +
    `<Speak voice="${esc(v.voice)}" language="${esc(v.language)}">${esc(text)}</Speak>` +
    `</GetInput>` +
    `<Redirect method="POST">${esc(actionUrl)}</Redirect>` +
    `</Response>`
  );
}

/** PLAY a pre-generated audio file (cloned/ElevenLabs voice) while
 *  listening for the contact's reply — same shape as xmlSpeakGetInput,
 *  with <Play> instead of <Speak>. Used by /assistant call-and-inform
 *  when the opening message was rendered in the user's enrolled voice. */
function xmlPlayGetInput({ audioUrl, actionUrl, lang }) {
  const v = voiceFor(lang);
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<GetInput action="${esc(actionUrl)}" method="POST" inputType="speech" ` +
    `language="${esc(v.language)}" speechEndTimeout="3" executionTimeout="20" ` +
    `redirect="true" profanityFilter="false">` +
    `<Play>${esc(audioUrl)}</Play>` +
    `</GetInput>` +
    `<Redirect method="POST">${esc(actionUrl)}</Redirect>` +
    `</Response>`
  );
}

/** Speak [text] and hang up. */
function xmlSpeakHangup({ text, lang }) {
  const v = voiceFor(lang);
  const speak = text
    ? `<Speak voice="${esc(v.voice)}" language="${esc(v.language)}">${esc(text)}</Speak>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${speak}<Hangup/></Response>`;
}

module.exports = {
  configured,
  toE164,
  createCall,
  hangup,
  validSignature,
  xmlSpeakGetInput,
  xmlPlayGetInput,
  xmlSpeakHangup,
};
