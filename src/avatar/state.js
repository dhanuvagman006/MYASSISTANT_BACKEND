/**
 * CONVERSATION STATE (§18, §19) — the compact bridge between temporary
 * live sessions and the persistent assistant.
 *
 * Not a transcript archive: a rolling window of the most recent turns,
 * capped hard, deterministic (no extra model calls on the hot path).
 * Durable FACTS go to the memory system (agents/memory); this only
 * carries short-term conversational continuity — "you were telling me
 * about Ravi's hearing" — across app launches.
 */
const { one, run } = require("../db");

const MAX_CHARS = 2200; // ~a dozen spoken turns
const MAX_TURN = 300; // one utterance, trimmed

async function getSummary(userId) {
  if (!userId) return "";
  const row = await one(
    `SELECT summary FROM conversation_state WHERE user_id=$1`,
    [userId]
  );
  return row?.summary || "";
}

/** Appends one exchange, keeping only the newest MAX_CHARS. */
async function appendTurn(userId, userText, assistantText) {
  if (!userId) return;
  const u = String(userText || "").trim().slice(0, MAX_TURN);
  const a = String(assistantText || "").trim().slice(0, MAX_TURN);
  if (!u && !a) return;
  const line =
    (u ? `User: ${u}\n` : "") + (a ? `Assistant: ${a}\n` : "");
  const prev = await getSummary(userId);
  let next = prev + line;
  if (next.length > MAX_CHARS) {
    // Drop whole oldest lines, never mid-sentence.
    next = next.slice(next.length - MAX_CHARS);
    const nl = next.indexOf("\n");
    if (nl >= 0) next = next.slice(nl + 1);
  }
  await run(
    `INSERT INTO conversation_state (user_id, summary, updated_at)
     VALUES ($1,$2,$3)
     ON CONFLICT (user_id) DO UPDATE SET summary=$2, updated_at=$3`,
    [userId, next, Date.now()]
  );
}

module.exports = { getSummary, appendTurn, MAX_CHARS };
