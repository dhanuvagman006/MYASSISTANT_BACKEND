const router = require("express").Router();
const { generateReply } = require("../services/ai/router");

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

  try {
    const { reply, provider } = await generateReply(trimmed);
    res.json({ reply: reply || "Sorry, I couldn't answer that.", sources: [], provider });
  } catch (e) {
    console.error("All providers failed:", e.message);
    res.status(502).json({ reply: "The assistant is unavailable right now. Please try again.", sources: [] });
  }
});

module.exports = router;
