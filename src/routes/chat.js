const router = require("express").Router();
const { generateReply } = require("../services/ai/router");
const { buildMemoryPrompt } = require("../memory/store");
const { extractAndSave } = require("../memory/extractor");
const { buildToolContext } = require("../services/intents");

/** Numeric DB user id for signed-in accounts; null for dev/app-key sessions. */
function userIdOf(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
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
    const toolBlock = await buildToolContext({
      userId,
      messages: trimmed,
      tzOffsetMin: Number(req.get("X-TZ-Offset")) || 330,
      lat: parseFloat(req.get("X-Geo-Lat")),
      lng: parseFloat(req.get("X-Geo-Lng")),
    });
    const extraSystem = (userId ? buildMemoryPrompt(userId) : "") + toolBlock;
    const { reply, provider } = await generateReply(trimmed, { extraSystem });
    res.json({ reply: reply || "Sorry, I couldn't answer that.", sources: [], provider });

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
 * POST /chat/greeting — spoken greeting for app open / sign-in.
 * Personalized from memory; if Hari barely knows the user yet, it asks
 * ONE friendly question so the extractor can start learning about them.
 */
router.post("/greeting", async (req, res) => {
  const userId = userIdOf(req);
  const memoryBlock = userId ? buildMemoryPrompt(userId) : "";
  const known = userId ? require("../memory/store").listMemories(userId) : [];
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
