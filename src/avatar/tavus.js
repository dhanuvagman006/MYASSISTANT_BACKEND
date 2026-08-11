/**
 * AVATAR — real-time human face via Tavus CVI (tavusapi.com).
 *
 * Why Tavus (researched Aug 2026): it is the real-time conversational
 * specialist — the user talks WITH a photoreal human over WebRTC
 * (sub-second turns, natural interruptions), versus generation APIs
 * that render clips. Integration is one POST that returns a
 * `conversation_url` the app embeds in a WebView; Tavus runs the whole
 * low-latency loop (VAD, STT, LLM, TTS, lip-synced video).
 *
 * PERSONALIZATION: every session's `conversational_context` is built
 * from OUR persona + the user's remembered facts (agents/memory), so
 * the face greets the user by name and knows their life — same person
 * as the orb voice loop.
 *
 * Env (feature hidden while unset):
 *   TAVUS_API_KEY   from platform.tavus.io (free tier ~25 conversation minutes)
 *   TAVUS_FACE_ID   a face/replica id — pick a stock female face in the
 *                   Tavus platform library and paste its id
 *   TAVUS_PAL_ID    optional; a PAL configured in Tavus (can carry a
 *                   custom-LLM layer pointing back at this server later)
 *   TAVUS_MAX_CALL_SECONDS  optional, default 900 (guards the free tier)
 *
 * Routes:
 *   GET  /avatar/status   -> { enabled }
 *   POST /avatar/session  -> { url }   (starts a conversation)
 */
const router = require("express").Router();
const { one } = require("../db");
const memory = require("../agents/memory");

const TAVUS_BASE = "https://tavusapi.com";
const enabled = () =>
  Boolean(process.env.TAVUS_API_KEY && process.env.TAVUS_FACE_ID);

function uidOf(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The face's brain-context: who she is + who the user is. */
async function buildContext(userId) {
  let userLine = "";
  if (userId) {
    try {
      const u = await one(`SELECT name, gender FROM users WHERE id=$1`, [userId]);
      if (u?.name) userLine = `The user's name is ${u.name}. `;
    } catch (_) {}
  }
  let facts = "";
  try {
    const rows = await memory.listMemories(userId);
    if (rows.length) {
      facts =
        "Things you remember about them from earlier conversations " +
        "(use naturally, never recite): " +
        rows.map((r) => r.fact).join("; ") +
        ". ";
    }
  } catch (_) {}
  return (
    "You are Hari, the user's warm, quick-witted personal assistant and " +
    "friend. Speak naturally like a human on a video call: contractions, " +
    "short sentences, one thought at a time, brief genuine reactions. " +
    "Match the user's language. " +
    userLine +
    facts +
    "Never mention being an avatar or AI unless directly asked; if asked, " +
    "answer honestly and lightly, then move on."
  );
}

router.get("/status", (_req, res) => res.json({ enabled: enabled() }));

router.post("/session", async (req, res) => {
  if (!enabled()) {
    return res.status(503).json({ error: "avatar not configured" });
  }
  const userId = uidOf(req);
  try {
    const body = {
      face_id: process.env.TAVUS_FACE_ID,
      conversational_context: await buildContext(userId),
      custom_greeting: "Hey! Good to see you.",
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
    res.json({ url: j.conversation_url, conversationId: j.conversation_id });
  } catch (e) {
    console.error("tavus error:", e.message);
    res.status(502).json({ error: "avatar unavailable" });
  }
});

module.exports = router;
