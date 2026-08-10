const router = require("express").Router();
const { generateReply, generateReplyStream } = require("../services/ai/router");
const { buildToolContext } = require("../services/intents");

/** Numeric DB user id for signed-in accounts; null for dev/app-key sessions. */
function userIdOf(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** A4 — assistant style settings, sent by the app as headers. */
const TONES = {
  friendly: "Speak warmly and casually, like a close friend.",
  professional: "Speak politely and precisely, with a professional tone.",
  cheerful: "Be upbeat, positive and encouraging.",
  calm: "Keep a calm, soothing, unhurried tone.",
};
const LENGTHS = {
  short: "Keep every answer to ONE short spoken sentence unless more is essential.",
  balanced: "", // the base prompt's 1–3 sentence default
  detailed: "Give fuller answers of 4–6 spoken sentences when the topic benefits from detail.",
};
function styleDirective(req) {
  const t = TONES[String(req.get("X-Style-Tone") || "").toLowerCase()];
  const l = LENGTHS[String(req.get("X-Style-Length") || "").toLowerCase()];
  if (!t && !l) return "";
  return "\n\nUSER STYLE PREFERENCE: " + [t, l].filter(Boolean).join(" ");
}

router.post("/", async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }
  // Keep context bounded (cost + latency)
  const trimmed = messages.slice(-20).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 8000),
  }));

  const userId = userIdOf(req);

  try {
    // Tools: intents (reminders/weather/news/clock) run first — they may
    // EXECUTE actions and inject live data the AI must answer from.
    const toolCtx = await buildToolContext({
      userId,
      messages: trimmed,
      tzOffsetMin: Number(req.get("X-TZ-Offset")) || 330,
      lat: parseFloat(req.get("X-Geo-Lat")),
      lng: parseFloat(req.get("X-Geo-Lng")),
    });
    // A4 — user-selected style rides on headers; a plain string concat,
    // so personalization costs zero extra latency.
    const extraSystem = toolCtx.block + styleDirective(req);
    const { reply, provider } = await generateReply(trimmed, { extraSystem });
    res.json({
      reply: reply || "Sorry, I couldn't answer that.",
      sources: toolCtx.sources,
      documents: toolCtx.documents || [],
      provider,
    });

  } catch (e) {
    console.error("All providers failed:", e.message);
    res.status(502).json({ reply: "The assistant is unavailable right now. Please try again.", sources: [] });
  }
});

/**
 * POST /chat/stream — NDJSON streaming chat for the VOICE loop.
 * Lines: {"d":"delta"}… then {"done":true,"sources":[…],"provider":…}.
 * The app speaks each sentence the moment it completes, so the user
 * hears the start of the answer while the rest is still generating.
 * Falls back to non-streaming Gemini if streaming can’t start.
 */
router.post("/stream", async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }
  const trimmed = messages.slice(-20).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 8000),
  }));
  const userId = userIdOf(req);

  let sources = [];
  let documents = [];
  let full = "";
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no"); // proxies must not buffer the stream
  res.flushHeaders?.();
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    const ctx = await buildToolContext({
      userId,
      messages: trimmed,
      tzOffsetMin: Number(req.get("X-TZ-Offset")) || 330,
      lat: parseFloat(req.get("X-Geo-Lat")),
      lng: parseFloat(req.get("X-Geo-Lng")),
    });
    sources = ctx.sources;
    documents = ctx.documents || [];
    const extraSystem =
      ctx.block +
      styleDirective(req);

    try {
      for await (const d of generateReplyStream(trimmed, { extraSystem })) {
        full += d;
        send({ d });
      }
      send({ done: true, sources, documents, provider: "gemini" });
    } catch (e) {
      if (full) {
        // Stream broke mid-answer: end cleanly with what was sent.
        send({ done: true, sources, documents, provider: "gemini" });
      } else {
        // Streaming couldn’t start: non-streaming Gemini, sent as one delta.
        const { reply, provider } = await generateReply(trimmed, { extraSystem });
        full = reply || "";
        send({ d: full });
        send({ done: true, sources, documents, provider });
      }
    }
  } catch (e) {
    console.error("stream chat failed:", e.message);
    send({ error: "unavailable" });
  }
  res.end();

});

/**
 * POST /chat/greeting — spoken greeting for app open / sign-in.
 */
router.post("/greeting", async (req, res) => {
  const name = req.user?.name ? String(req.user.name).split(" ")[0] : null;
  try {
    const { reply } = await generateReply(
      [{ role: "user", content: "(The user just opened the app and signed in. Greet them.)" }],
      {
        extraSystem:
          (name ? `\n\nThe user's name is ${name}.` : "") +
          "\n\nTASK: The user just opened the app. Greet them warmly by name if you " +
          "know it, matching the time of day if unknown just be warm. Maximum two short " +
          "spoken sentences.",
      }
    );
    res.json({ greeting: reply || "Hi! I'm Hari. What should I call you?" });
  } catch (e) {
    // Never block the app on a greeting — fall back to a static one.
    const name = req.user?.name ? `, ${String(req.user.name).split(" ")[0]}` : "";
    res.json({ greeting: `Hi${name}! I'm Hari — how can I help you today?` });
  }
});

module.exports = router;
