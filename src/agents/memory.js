/**
 * PER-USER MEMORY — what makes the conversational agent PERSONAL.
 *
 * Durable facts learned from conversation ("her name is Dhanya", "lives
 * in Mysuru", "vegetarian", "prefers Kannada", "exam on the 20th") are
 * stored per user and injected into EVERY agent's system prompt — the
 * voice loop, the chat screen and the D-ID photoreal face all remember
 * the same person.
 *
 * Extraction runs AFTER the reply has already been sent (fire-and-
 * forget), and only when the message looks self-descriptive — so
 * remembering costs the user zero latency and near-zero extra tokens.
 *
 * Table: agent_memories (created in db.js init()).
 */
const { query, one, run } = require("../db");
const { generateReply } = require("../services/ai/router");

const MAX_MEMORIES = 60; // per user; oldest low-importance evicted

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/** All memories for a user, most important + newest first. */
async function listMemories(userId) {
  if (!userId) return [];
  return query(
    `SELECT id, fact, importance, created_at FROM agent_memories
      WHERE user_id=$1 ORDER BY importance DESC, id DESC LIMIT $2`,
    [userId, MAX_MEMORIES]
  );
}

/**
 * The block injected into system prompts. Empty string when there is
 * nothing remembered (or no signed-in user) — prompts stay clean.
 */
async function memoryBlock(userId) {
  const rows = await listMemories(userId).catch(() => []);
  if (!rows.length) return "";
  const facts = rows.map((r) => "- " + r.fact).join("\n");
  return (
    "\n\nWHAT YOU REMEMBER ABOUT THIS USER (from earlier conversations; " +
    "use naturally, never recite as a list, never claim to 'have notes'):\n" +
    facts
  );
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

async function saveMemory(userId, fact, importance = 2) {
  if (!userId || !fact) return;
  const f = String(fact).trim().slice(0, 300);
  if (!f) return;
  // Skip near-duplicates (same fact re-learned across sessions).
  const dup = await one(
    `SELECT id FROM agent_memories WHERE user_id=$1 AND lower(fact)=lower($2)`,
    [userId, f]
  );
  if (dup) return;
  await run(
    `INSERT INTO agent_memories (user_id, fact, importance, created_at)
     VALUES ($1,$2,$3,$4)`,
    [userId, f, importance, Date.now()]
  );
  // Evict beyond the cap: lowest importance, oldest first.
  await run(
    `DELETE FROM agent_memories WHERE id IN (
       SELECT id FROM agent_memories WHERE user_id=$1
       ORDER BY importance ASC, id ASC
       OFFSET $2)`,
    [userId, MAX_MEMORIES]
  );
}

/**
 * Remove facts containing an exact substring (LIKE-escaped). Used when a
 * saved document is deleted so its "Saved a receipt: …" context fact
 * doesn't outlive the file. Returns the number of facts removed.
 */
async function deleteFactsContaining(userId, substring) {
  if (!userId) return 0;
  const s = String(substring || "").trim();
  if (s.length < 3) return 0; // never mass-delete on a junk needle
  const escaped = s.replace(/([%_\\])/g, "\\$1");
  return run(
    `DELETE FROM agent_memories WHERE user_id = $1 AND fact LIKE $2 ESCAPE '\\'`,
    [userId, `%${escaped}%`]
  );
}

/** Full wipe — called from the privacy/deletion path. */
async function deleteAllMemories(userId) {
  if (!userId) return;
  await run(`DELETE FROM agent_memories WHERE user_id=$1`, [userId]);
}

/* ------------------------------------------------------------------ */
/* Extraction (async, post-reply)                                      */
/* ------------------------------------------------------------------ */

// Only bother the extractor when the user plausibly told us something
// about themselves — keeps cost at ~zero for ordinary Q&A turns.
const SELF_RX =
  /\b(my name|i am|i'm|im |call me|i live|i work|i study|i like|i love|i hate|i prefer|my (wife|husband|mom|dad|amma|appa|sister|brother|son|daughter|friend|birthday|exam|job|boss|school|college|city|village)|i can'?t eat|allergic|vegetarian|vegan|remember (that|this)|nanna hesaru|mera naam)\b/i;

function looksSelfDescriptive(text) {
  return SELF_RX.test(String(text || ""));
}

const EXTRACT_PROMPT =
  "You extract durable personal facts from one user message for a personal " +
  "assistant's long-term memory. Return STRICT JSON only — an array of " +
  'objects: [{"fact":"...","importance":1|2|3}] — no markdown, no prose. ' +
  "Facts must be about the USER (name, family, city, work, likes, health " +
  "constraints, important dates), written as short third-person statements " +
  "(\"User's name is Dhanya\"). importance: 3 = identity/health, 2 = " +
  "preferences/relationships, 1 = minor. If nothing durable, return [].";

/**
 * Fire-and-forget: never throws, never blocks the reply.
 * @param {number} userId
 * @param {string} userText the raw user message/transcript
 */
function extractAndStore(userId, userText) {
  if (!userId || !looksSelfDescriptive(userText)) return;
  (async () => {
    try {
      const { reply } = await generateReply(
        [{ role: "user", content: String(userText).slice(0, 1500) }],
        { system: EXTRACT_PROMPT }
      );
      const clean = String(reply || "").replace(/```json|```/g, "").trim();
      const facts = JSON.parse(clean);
      if (!Array.isArray(facts)) return;
      for (const f of facts.slice(0, 5)) {
        const imp = [1, 2, 3].includes(f?.importance) ? f.importance : 2;
        await saveMemory(userId, f?.fact, imp);
      }
    } catch (_) {
      /* memory is best-effort by design */
    }
  })();
}

module.exports = {
  listMemories,
  memoryBlock,
  saveMemory,
  deleteAllMemories,
  deleteFactsContaining,
  extractAndStore,
  looksSelfDescriptive,
};
