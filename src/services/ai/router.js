/**
 * AI PROVIDER ROUTER
 * ------------------
 * Provider CHAIN, tried in order until one answers (satisfies the
 * contract's two-provider requirement):
 *
 *   groq   — Llama 3.3 70B on LPU hardware. Fastest inference available,
 *            generous free tier. DEFAULT FIRST for latency.
 *   gemini — Gemini 2.0 Flash. Strong quality, small free-tier quota
 *            (the "429" you see when it runs out). DEFAULT FALLBACK.
 *
 * Order is configurable: AI_PROVIDER_ORDER=groq,gemini
 * Providers without an API key set are skipped automatically.
 *
 * Latency rule: on 429 (quota) we do NOT wait and retry — we jump straight
 * to the next provider. Retry-after-delay only happens for transient
 * network/5xx errors on the LAST provider in the chain.
 */

const SYSTEM_PROMPT =
  "You are MyAssistant ('Hari'), a warm and helpful voice assistant for Indian users. " +
  "Your replies are READ ALOUD by text-to-speech, so: reply in the SAME language and " +
  "SAME script the user used (Kannada in Kannada script, Hindi in Devanagari, Hinglish " +
  "in Latin, etc.); keep answers short and conversational — 1 to 3 spoken sentences " +
  "unless the user asks for detail; never use markdown, bullet points, tables, code " +
  "blocks, emojis or URLs; write numbers and abbreviations the way they should be " +
  "spoken. Decline harmful requests politely.";

const TIMEOUT_MS = 30_000;

// ---------------- GROQ (OpenAI-compatible API) ----------------

async function callGroq(messages) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("groq: key missing");
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      temperature: 0.6,
      max_tokens: 1024,
    }),
  });
  if (!r.ok) throw new Error(`groq ${r.status}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || "";
}

// ---------------- GEMINI ----------------

async function callGemini(messages) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("gemini: key missing");
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

// ---------------- CHAIN ----------------

const PROVIDERS = {
  groq: { call: callGroq, hasKey: () => !!process.env.GROQ_API_KEY },
  gemini: { call: callGemini, hasKey: () => !!process.env.GEMINI_API_KEY },
};

function chain() {
  const order = (process.env.AI_PROVIDER_ORDER || "groq,gemini")
    .split(",")
    .map((s) => s.trim())
    .filter((name) => PROVIDERS[name]?.hasKey());
  return order;
}

async function generateReply(messages) {
  const order = chain();
  if (order.length === 0) {
    throw new Error("no AI provider configured — set GROQ_API_KEY and/or GEMINI_API_KEY");
  }

  const errors = [];
  for (let i = 0; i < order.length; i++) {
    const name = order[i];
    const isLast = i === order.length - 1;
    try {
      return { reply: await PROVIDERS[name].call(messages), provider: name };
    } catch (e) {
      errors.push(e.message);
      const msg = String(e.message);
      const transient = msg.includes("timeout") || /\b5\d\d\b/.test(msg) || e.name === "TimeoutError";
      // Last provider + transient error: one short-delay retry before giving up.
      if (isLast && transient) {
        await new Promise((res) => setTimeout(res, 800));
        try {
          return { reply: await PROVIDERS[name].call(messages), provider: name };
        } catch (e2) {
          errors.push(e2.message);
        }
      }
      // Otherwise (429/quota/anything): fall through to the next provider immediately.
    }
  }
  throw new Error(`All providers failed: ${errors.join(" | ")}`);
}

module.exports = { generateReply };
