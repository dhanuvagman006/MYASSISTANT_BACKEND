const router = require("express").Router();
const { generateReply, generateReplyStream } = require("../services/ai/router");
const { buildMemoryPrompt } = require("../memory/store");
const { extractAndSave } = require("../memory/extractor");
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
    // Personalization: everything Hari knows about THIS user rides along
    // as an addition to the system prompt on every single reply.
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
    const extraSystem =
      (userId
        ? await buildMemoryPrompt(userId, {
            excludeDocFacts: (toolCtx.documents || []).length > 0,
          })
        : "") +
      toolCtx.block +
      styleDirective(req);
    const { reply, provider } = await generateReply(trimmed, { extraSystem });
    res.json({
      reply: reply || "Sorry, I couldn't answer that.",
      sources: toolCtx.sources,
      documents: toolCtx.documents || [],
      provider,
    });

    // Learning: AFTER the response is sent, quietly check whether this
    // exchange taught us something durable about the user. Never awaited.
    if (userId && reply) {
      const lastUser = [...trimmed].reverse().find((m) => m.role === "user");
      if (lastUser) extractAndSave(userId, lastUser.content, reply);
    }
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
 * Falls back to the full non-streaming chain if Groq can't stream.
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
      (userId ? await buildMemoryPrompt(userId) : "") + ctx.block + styleDirective(req);

    try {
      for await (const d of generateReplyStream(trimmed, { extraSystem })) {
        full += d;
        send({ d });
      }
      send({ done: true, sources, documents, provider: "groq" });
    } catch (e) {
      if (full) {
        // Stream broke mid-answer: end cleanly with what was sent.
        send({ done: true, sources, documents, provider: "groq" });
      } else {
        // Groq couldn't start: full provider chain, sent as one delta.
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

  if (userId && full) {
    const lastUser = [...trimmed].reverse().find((m) => m.role === "user");
    if (lastUser) extractAndSave(userId, lastUser.content, full);
  }
});

/**
 * POST /chat/greeting — spoken greeting for app open / sign-in.
 * Personalized from memory; if Hari barely knows the user yet, it asks
 * ONE friendly question so the extractor can start learning about them.
 */
router.post("/greeting", async (req, res) => {
  const userId = userIdOf(req);
  const memoryBlock = userId ? await buildMemoryPrompt(userId) : "";
  const known = userId ? await require("../memory/store").listMemories(userId) : [];
  const learned = known.filter((m) => m.category !== "profile").length;

  const directive =
    learned < 3
      ? "You know almost nothing about them yet, so after greeting, ask exactly ONE " +
        "short, friendly question to get to know them — for example what they'd like " +
        "to be called, which city they live in, or what they do. Just one question."
      : "Weave in ONE personal touch from what you remember (their city, a preference, " +
        "their work) so it feels like a friend who knows them. You may ask one light " +
        "follow-up question about something you remember, or none.";

  try {
    const { reply } = await generateReply(
      [{ role: "user", content: "(The user just opened the app and signed in. Greet them.)" }],
      {
        extraSystem:
          memoryBlock +
          "\n\nTASK: The user just opened the app. Greet them warmly by name if you " +
          "know it, matching the time of day if unknown just be warm. Maximum two short " +
          "spoken sentences. " + directive,
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
