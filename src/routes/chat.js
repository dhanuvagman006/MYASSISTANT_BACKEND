const router = require("express").Router();
const { generateReply } = require("../services/ai/router");
const { buildMemoryPrompt } = require("../memory/store");
const { extractAndSave } = require("../memory/extractor");

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
    const extraSystem = userId ? buildMemoryPrompt(userId) : "";
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

module.exports = router;
