/**
 * AI PROVIDER ROUTER
 * ------------------
 * Gemini is the only provider. Note: the contract (Section 5) requires
 * at least two AI providers — re-add a fallback before production.
 */

const SYSTEM_PROMPT =
  "You are MyAssistant, a warm and helpful personal assistant for Indian users. " +
  "Detect and reply in the user's language — English, Hindi, Malayalam, or any " +
  "other language they use, including mixed usage. Be concise. Decline harmful " +
  "requests politely.";

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
  return { reply: await callGemini(messages), provider: "gemini" };
}

module.exports = { generateReply };
