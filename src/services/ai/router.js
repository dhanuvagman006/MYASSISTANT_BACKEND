/**
 * AI PROVIDER ROUTER
 * ------------------
 * The contract (Section 5) requires at least two AI providers so the
 * app never depends on a single company. This router tries the primary
 * provider and fails over to the secondary automatically.
 */

const SYSTEM_PROMPT =
  "You are MyAssistant, a warm and helpful personal assistant for Indian users. " +
  "Detect and reply in the user's language — English, Hindi, Malayalam, or any " +
  "other language they use, including mixed usage. Be concise. Decline harmful " +
  "requests politely.";

async function callAnthropic(messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}`);
  const data = await r.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function callGemini(messages) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("gemini key missing");
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
      }),
    }
  );
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
}

async function generateReply(messages) {
  try {
    return { reply: await callAnthropic(messages), provider: "anthropic" };
  } catch (e) {
    console.warn("Primary provider failed, trying fallback:", e.message);
    return { reply: await callGemini(messages), provider: "gemini" };
  }
}

module.exports = { generateReply };
