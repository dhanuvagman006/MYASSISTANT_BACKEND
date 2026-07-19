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

const GEMINI_TIMEOUT_MS = 30_000;

async function callGemini(messages, { retry = true } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("gemini key missing");
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  // Key goes in a header, never the URL — URLs end up in proxy/server logs.
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
      }),
    }
  ).catch((e) => {
    // Timeouts/network blips: one retry, then give up.
    if (retry) return null;
    throw e;
  });

  // Retry once on transient failures (timeout, 429, 5xx)
  if (retry && (r === null || r.status === 429 || r.status >= 500)) {
    await new Promise((res) => setTimeout(res, 800));
    return callGemini(messages, { retry: false });
  }

  if (!r || !r.ok) throw new Error(`gemini ${r ? r.status : "network/timeout"}`);
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
}

async function generateReply(messages) {
  return { reply: await callGemini(messages), provider: "gemini" };
}

module.exports = { generateReply };
