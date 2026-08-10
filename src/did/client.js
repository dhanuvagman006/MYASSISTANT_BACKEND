/**
 * D-ID API CLIENT — thin fetch wrapper around https://api.d-id.com.
 *
 * What we use D-ID for (docs.d-id.com):
 *  - AGENTS (Realtime): a streaming talking-avatar "Face Mode" for Hari.
 *    Each agent is configured with a CUSTOM LLM pointing back at THIS
 *    server (/did/llm/v1/chat/completions), so the avatar speaks with
 *    Hari's real brain — memory, documents, tools, regional language.
 *  - TALKS (V2 photo avatars, async video): the daily video briefing —
 *    Hari's face reads the user's morning summary, generated overnight.
 *
 * Auth: `Authorization: Basic <DID_API_KEY>` (the key from D-ID Studio is
 * already in `username:password` form; we base64 it here).
 *
 * Everything is disabled cleanly when DID_API_KEY is unset — routes
 * return 503 and the app hides Face Mode via remote config.
 */

const BASE = process.env.DID_API_BASE || "https://api.d-id.com";
const TIMEOUT_MS = 30_000;

function enabled() {
  return Boolean(process.env.DID_API_KEY);
}

function authHeader() {
  const key = process.env.DID_API_KEY || "";
  // Studio keys look like "am9...:x8Z..." — Basic auth wants base64 of that.
  const encoded = key.includes(":") ? Buffer.from(key).toString("base64") : key;
  return `Basic ${encoded}`;
}

async function api(method, path, body) {
  if (!enabled()) throw new Error("did: DID_API_KEY not configured");
  const r = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {}
  if (!r.ok) {
    const msg = (json && (json.description || json.message || json.kind)) || text || r.statusText;
    const err = new Error(`did ${method} ${path} → ${r.status}: ${String(msg).slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return json;
}

/* ------------------------------------------------------------------ */
/* Agents (Realtime "Face Mode")                                       */
/* ------------------------------------------------------------------ */

/**
 * Presenter for the streaming agent. Defaults to a D-ID stock presenter;
 * set DID_PRESENTER_SOURCE_URL to a photo of Hari's own custom face
 * (V3 Instant Avatar footage or a brand portrait) to look unique.
 */
function presenterConfig(gender) {
  // gender = the AVATAR's gender ('male' | 'female'), already resolved as
  // the opposite of the user's. Per-gender custom faces first, then
  // per-gender stock presenters, then the legacy single-face env vars.
  const srcByGender =
    gender === "male"
      ? process.env.DID_PRESENTER_SOURCE_URL_MALE
      : process.env.DID_PRESENTER_SOURCE_URL_FEMALE;
  const src = srcByGender || process.env.DID_PRESENTER_SOURCE_URL;
  if (src) {
    return {
      type: "talk", // photo-based presenter streamed over WebRTC
      source_url: src,
      voice: voiceConfig(gender),
    };
  }
  const idByGender =
    gender === "male"
      ? process.env.DID_PRESENTER_ID_MALE
      : process.env.DID_PRESENTER_ID_FEMALE;
  if (gender === "male" && !idByGender && !process.env.DID_PRESENTER_ID) {
    console.warn(
      "DID_PRESENTER_ID_MALE not set — male avatar falls back to the default (female) presenter. " +
        "Pick a male presenter id from GET https://api.d-id.com/clips/presenters and set it."
    );
  }
  return {
    type: "clip", // stock Full-HD presenter
    presenter_id:
      idByGender || process.env.DID_PRESENTER_ID || "v2_public_Amber@0zSz8kflCN",
    voice: voiceConfig(gender),
  };
}

function voiceConfig(gender) {
  // Multilingual Indian neural voices → speak Kannada/Hindi/English as
  // Hari switches language mid-conversation. Voice matches the avatar.
  const byGender =
    gender === "male"
      ? process.env.DID_VOICE_ID_MALE || "en-IN-PrabhatIndicNeural"
      : process.env.DID_VOICE_ID_FEMALE;
  return {
    type: "microsoft",
    voice_id: byGender || process.env.DID_VOICE_ID || "en-IN-AartiIndicNeural",
  };
}

/**
 * Create one D-ID agent wired to OUR custom-LLM endpoint.
 * `userToken` is a signed JWT identifying the user + mode; D-ID attaches
 * it as a header on every LLM call so /did/llm can personalize.
 */
async function createAgent({ name, instructions, llmUrl, llmKey, userToken, greeting, avatarGender }) {
  return api("POST", "/agents", {
    preview_name: name,
    presenter: presenterConfig(avatarGender),
    llm: {
      type: "custom",
      provider: "custom",
      url: llmUrl,
      key: llmKey, // sent back to us as x-api-key — our shared secret
      streaming: true,
      max_messages: 20,
      headers: { "x-hari-user": userToken },
      instructions:
        instructions ||
        "You are Hari, a warm personal assistant for Indian users. Keep replies to 1-3 short spoken sentences.",
    },
    greetings: greeting ? [greeting] : undefined,
  });
}

async function deleteAgent(agentId) {
  return api("DELETE", `/agents/${encodeURIComponent(agentId)}`).catch(() => null);
}

/**
 * Short-lived client key the embed page uses from the WebView.
 * Allowed domains lock it to our own hosted face page.
 */
async function createClientKey(agentId, allowedDomains) {
  const body = { allowed_domains: allowedDomains };
  // Newer API scopes the key to specific agents when provided.
  if (agentId) body.agents = [agentId];
  return api("POST", "/agents/client-key", body);
}

/* ------------------------------------------------------------------ */
/* Talks (async V2 photo-avatar videos — the daily video briefing)     */
/* ------------------------------------------------------------------ */

async function createTalk({ text, lang }) {
  const source =
    process.env.DID_PRESENTER_SOURCE_URL ||
    process.env.DID_BRIEFING_IMAGE_URL ||
    "https://d-id-public-bucket.s3.amazonaws.com/alice.jpg"; // D-ID sample face
  return api("POST", "/talks", {
    source_url: source,
    script: {
      type: "text",
      input: String(text).slice(0, 1800), // keep briefing videos short & cheap
      provider: voiceConfig(),
    },
    config: { fluent: true, stitch: true },
    // lang is informational; the multilingual voice reads the script as-is
    name: `briefing-${lang || "en"}-${new Date().toISOString().slice(0, 10)}`,
  });
}

async function getTalk(talkId) {
  return api("GET", `/talks/${encodeURIComponent(talkId)}`);
}

module.exports = {
  enabled,
  createAgent,
  deleteAgent,
  createClientKey,
  createTalk,
  getTalk,
};
