/**
 * AVATAR — real-time human face via Tavus CVI (tavusapi.com).
 *
 * This is the ONE canonical live-video path (Rebuild Directive §7): the
 * backend mints a conversation and returns a WebRTC room URL; the app's
 * LiveScreen embeds it full-screen. Tavus runs the whole low-latency
 * loop (VAD, STT, LLM, TTS, lip-synced video, barge-in).
 *
 * PERSONALIZATION (§15–§18): every session is built from the user's own
 * data via users/context — the configured assistant name/gender/style,
 * the user's name, standing instructions, and remembered facts — so the
 * face IS the same assistant as the rest of the product, not a stranger.
 *
 * GREETING (§10, §15): the greeting is delivered by Tavus itself as
 * `custom_greeting`, spoken only after the participant has actually
 * joined the live room. It is therefore structurally impossible for the
 * greeting to fire while disconnected — the app never speaks it.
 *
 * OPPOSITE-GENDER DEFAULT (§16): if the user has not explicitly chosen
 * an assistant gender, a male user gets the female replica and a female
 * user gets the male replica (when both are configured).
 *
 * Env (feature hidden while unset):
 *   TAVUS_API_KEY        from platform.tavus.io
 *   TAVUS_FACE_ID        default face/replica id (female stock face)
 *   TAVUS_FACE_ID_MALE   optional male face for the opposite-gender rule
 *   TAVUS_PAL_ID         optional persona layer
 *   TAVUS_MAX_CALL_SECONDS  optional, default 900
 *
 * Routes:
 *   GET  /avatar/status   -> { enabled }
 *   POST /avatar/session  -> { url, conversationId, assistantName }
 *        body: { localHour?: 0-23 }  (device-local hour for the greeting)
 */
const router = require("express").Router();
const memory = require("../agents/memory");
const userContext = require("../users/context");

const TAVUS_BASE = "https://tavusapi.com";
const enabled = () =>
  Boolean(process.env.TAVUS_API_KEY && process.env.TAVUS_FACE_ID);

function uidOf(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** "morning" | "afternoon" | "evening" from the user's local hour. */
function partOfDay(hour) {
  if (!Number.isFinite(hour)) return "";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

/** Local hour from body.localHour, else the user's stored IANA timezone. */
function resolveLocalHour(body, profile) {
  const h = Number(body?.localHour);
  if (Number.isInteger(h) && h >= 0 && h <= 23) return h;
  const tz = profile?.user?.timezone;
  if (tz) {
    try {
      return Number(
        new Intl.DateTimeFormat("en-GB", {
          hour: "numeric", hour12: false, timeZone: tz,
        }).format(new Date())
      );
    } catch (_) {}
  }
  return NaN;
}

/**
 * Everything about this session's identity, resolved from the DB:
 * assistant name/gender/style, face id, the greeting line, and the
 * conversational context. Falls back safely for anonymous/dev sessions.
 */
async function buildSession(userId, body) {
  let profile = null;
  let instructions = [];
  let facts = [];
  if (userId) {
    try { profile = await userContext.getProfile(userId); } catch (_) {}
    try { instructions = await userContext.listInstructions(userId); } catch (_) {}
    try { facts = await memory.listMemories(userId); } catch (_) {}
  }

  const userName = profile?.user?.name?.trim() || "";
  const userGender = String(profile?.user?.gender || "").toLowerCase();
  const assistant = profile?.assistant || { name: "Hari", gender: "", voice: "", style: "" };
  const assistantName = assistant.name || "Hari";

  // §16 — explicit preference wins; otherwise opposite of the user.
  let gender = String(assistant.gender || "").toLowerCase();
  if (!gender) {
    gender = userGender === "female" ? "male" : userGender === "male" ? "female" : "";
  }
  const faceId =
    gender === "male" && process.env.TAVUS_FACE_ID_MALE
      ? process.env.TAVUS_FACE_ID_MALE
      : process.env.TAVUS_FACE_ID;

  // §15 — greeting from stored config, never hard-coded names.
  const pod = partOfDay(resolveLocalHour(body, profile));
  const hello = pod ? `Good ${pod}` : "Hello";
  const greeting = userName
    ? `${hello}, ${userName}. I'm ${assistantName}. How can I help you today?`
    : `${hello}. I'm ${assistantName}. How can I help you today?`;

  // Conversational context: persona + user + rules + memory.
  const styleLine =
    assistant.style === "concise" ? "Keep replies short and to the point. " :
    assistant.style === "formal" ? "Keep a polished, professional tone. " :
    assistant.style === "friendly" ? "Be warm and personable. " : "";
  const rules = instructions.length
    ? "The user's standing rules — always respect them: " +
      instructions.map((r) => r.instruction).join("; ") + ". "
    : "";
  const memoryLine = facts.length
    ? "Things you remember about them from earlier conversations " +
      "(use naturally, never recite): " +
      facts.map((r) => r.fact).join("; ") + ". "
    : "";
  const userLine = userName ? `The user's name is ${userName}. ` : "";

  const context =
    `You are ${assistantName}, the user's warm, quick-witted personal ` +
    "assistant. Speak naturally like a human on a video call: contractions, " +
    "short sentences, one thought at a time, brief genuine reactions. " +
    "Match the user's language. " +
    styleLine + userLine + rules + memoryLine +
    "Never mention being an avatar or AI unless directly asked; if asked, " +
    "answer honestly and lightly, then move on.";

  return { faceId, assistantName, greeting, context };
}

router.get("/status", (_req, res) => res.json({ enabled: enabled() }));

router.post("/session", async (req, res) => {
  if (!enabled()) {
    return res.status(503).json({ error: "avatar not configured" });
  }
  const userId = uidOf(req);
  try {
    const s = await buildSession(userId, req.body || {});
    const body = {
      face_id: s.faceId,
      conversational_context: s.context,
      custom_greeting: s.greeting,
      properties: {
        language: "multilingual",
        max_call_duration:
          Number(process.env.TAVUS_MAX_CALL_SECONDS) || 900,
        participant_left_timeout: 30,
        participant_absent_timeout: 120,
      },
    };
    if (process.env.TAVUS_PAL_ID) body.pal_id = process.env.TAVUS_PAL_ID;

    const r = await fetch(`${TAVUS_BASE}/v2/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.TAVUS_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.conversation_url) {
      const msg = j?.message || j?.error || `HTTP ${r.status}`;
      console.error("tavus session failed:", msg);
      // 400 "maximum concurrent conversations" is common on free tier.
      return res
        .status(502)
        .json({ error: "avatar session failed", detail: String(msg).slice(0, 200) });
    }
    res.json({
      url: j.conversation_url,
      conversationId: j.conversation_id,
      assistantName: s.assistantName,
    });
  } catch (e) {
    console.error("tavus error:", e.message);
    res.status(502).json({ error: "avatar unavailable" });
  }
});

module.exports = router;
module.exports.buildSession = buildSession; // exported for tests
