/**
 * MEMORY EXTRACTOR
 * ----------------
 * After each /chat reply, this runs FIRE-AND-FORGET (never blocks or fails
 * the user's reply) and asks the AI chain: "did this exchange reveal any
 * NEW durable personal fact about the user?" Output is strict JSON which
 * is validated before anything touches the DB.
 *
 * Guardrails:
 *   • Durable facts only — no moods, no one-off requests, no small talk.
 *   • Explicitly forbidden: passwords, financial/government IDs, health
 *     details unless the user clearly asks Hari to remember them.
 *   • Per-user throttle (one extraction per EXTRACT_INTERVAL_MS) so a fast
 *     back-and-forth voice session doesn't burn provider quota.
 *   • Max 4 facts per exchange; store.remember() re-validates every field.
 */
const { generateReply } = require("../services/ai/router");
const store = require("./store");

const EXTRACT_INTERVAL_MS = 15_000;
const lastRun = new Map(); // userId -> ts (in-process; fine for one instance)

const EXTRACT_PROMPT = `You maintain the long-term memory of a personal voice assistant.
You will see ONE exchange (user message + assistant reply) plus facts already stored.
Decide if the USER revealed any NEW long-term personal fact worth remembering.

Remember ONLY durable facts: identity details, family, pets, work/study, home city,
preferences (food, music, teams, language), routines, important dates, goals.
NEVER remember: temporary states or moods, one-off requests, the assistant's words,
anything already in the stored list (unless the value changed), passwords, OTPs,
card/bank/government ID numbers, or health information the user did not explicitly
ask to be remembered.

Reply with ONLY a JSON array, no markdown, no prose. Each item:
{"key":"snake_case_key","value":"short plain-English fact","category":"profile|preference|fact|context"}
If there is nothing new to remember, reply exactly: []`;

/**
 * @param {number} userId
 * @param {string} userMessage  last user turn
 * @param {string} assistantReply
 */
async function extractAndSave(userId, userMessage, assistantReply) {
  try {
    if (!userMessage || userMessage.length < 8) return;
    const now = Date.now();
    if (now - (lastRun.get(userId) || 0) < EXTRACT_INTERVAL_MS) return;
    lastRun.set(userId, now);

    const known = store
      .listMemories(userId)
      .map((m) => `${m.key}: ${m.value}`)
      .join("\n")
      .slice(0, 2000);

    const { reply } = await generateReply(
      [
        {
          role: "user",
          content:
            `ALREADY STORED:\n${known || "(nothing yet)"}\n\n` +
            `USER SAID: ${userMessage.slice(0, 1500)}\n` +
            `ASSISTANT REPLIED: ${assistantReply.slice(0, 800)}`,
        },
      ],
      { system: EXTRACT_PROMPT }
    );

    // Strip accidental ```json fences, then parse defensively.
    const clean = reply.replace(/```json|```/g, "").trim();
    const start = clean.indexOf("[");
    const end = clean.lastIndexOf("]");
    if (start === -1 || end === -1) return;
    const facts = JSON.parse(clean.slice(start, end + 1));
    if (!Array.isArray(facts)) return;

    for (const f of facts.slice(0, 4)) {
      if (f && typeof f === "object") {
        store.remember(userId, {
          key: f.key,
          value: f.value,
          category: f.category,
          source: "ai",
        });
      }
    }
  } catch (e) {
    // Memory learning is best-effort — a failure here must never surface.
    console.warn("memory extractor skipped:", e.message);
  }
}

module.exports = { extractAndSave };
