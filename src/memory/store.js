/**
 * PER-USER MEMORY STORE (Postgres)
 * --------------------------------
 * Long-term facts about each user that make the assistant personal.
 * Three writers, one table:
 *   source='signup' — profile facts seeded from Google/Apple/email sign-up
 *   source='ai'     — durable facts the extractor learns from conversations
 *   source='user'   — facts the user adds/edits themselves in the app
 *
 * Design rules:
 *   • (user_id, key) is UNIQUE → saving the same key UPDATES the fact.
 *   • Hard cap per user (MAX_PER_USER); oldest AI-learned fact evicted
 *     first — signup/user facts are never auto-evicted.
 *   • Everything is plain rows the user can list and delete via /memory.
 * Schema lives in src/db.js init().
 */
const { query, one, run } = require("../db");

const MAX_PER_USER = 200;
const CATEGORIES = new Set(["profile", "preference", "fact", "context"]);

/** 'Favorite food' / 'favorite-food' / ' Favorite  Food ' → 'favorite_food' */
function slugKey(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

async function countFor(userId) {
  return (await one("SELECT COUNT(*)::int AS n FROM memories WHERE user_id = $1", [userId])).n;
}

/**
 * Save (insert-or-update) one memory. Returns the saved row or null if
 * the input was unusable. Safe to call with untrusted AI output.
 */
async function remember(userId, { key, value, category = "fact", source = "ai" }) {
  const k = slugKey(key);
  const v = String(value || "").trim().slice(0, 500);
  if (!k || !v) return null;
  const cat = CATEGORIES.has(category) ? category : "fact";

  // Enforce the cap only for NEW keys (updates never grow the table).
  const exists = await one(
    "SELECT 1 FROM memories WHERE user_id = $1 AND key = $2",
    [userId, k]
  );
  if (!exists && (await countFor(userId)) >= MAX_PER_USER) {
    await run(
      `DELETE FROM memories WHERE id IN (
         SELECT id FROM memories WHERE user_id = $1 AND source = 'ai'
         ORDER BY updated_at ASC LIMIT 1)`,
      [userId]
    ); // ai facts churn; signup/user facts stay
    if ((await countFor(userId)) >= MAX_PER_USER) return null; // all protected
  }

  const now = Date.now();
  return one(
    `INSERT INTO memories (user_id, category, key, value, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (user_id, key) DO UPDATE SET
       value = EXCLUDED.value,
       category = EXCLUDED.category,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [userId, cat, k, v, source, now]
  );
}

async function listMemories(userId) {
  return query(
    "SELECT * FROM memories WHERE user_id = $1 ORDER BY category, updated_at DESC",
    [userId]
  );
}

async function deleteMemory(userId, id) {
  return (await run("DELETE FROM memories WHERE user_id = $1 AND id = $2", [userId, id])) > 0;
}

/** Remove a memory by its key (used when a linked document is deleted). */
async function deleteByKey(userId, key) {
  return (await run(
    "DELETE FROM memories WHERE user_id = $1 AND key = $2",
    [userId, slugKey(key)]
  )) > 0;
}

async function clearMemories(userId) {
  return run("DELETE FROM memories WHERE user_id = $1", [userId]);
}

/**
 * Seed profile memories at sign-up (or first social sign-in).
 * Called from routes/auth.js with whatever the identity provider gave us.
 */
async function seedProfile(userId, { name, givenName, email, locale } = {}) {
  const put = (key, value) =>
    value
      ? remember(userId, { key, value, category: "profile", source: "signup" })
      : Promise.resolve(null);
  await put("profile_name", name);
  await put("profile_given_name", givenName);
  await put("profile_email", email);
  if (locale) await put("profile_locale", locale);
  // The avatar URL is not a "memory" — never store it, and clean up rows
  // seeded by older versions on the user's next sign-in.
  await deleteByKey(userId, "profile_picture");
}

/**
 * Render memories as a system-prompt block the AI reads on every reply.
 * Kept compact: category-grouped one-liners, hard character budget.
 */
async function buildMemoryPrompt(userId, { budget = 2200, excludeDocFacts = false } = {}) {
  const rows = await listMemories(userId);
  if (rows.length === 0) return "";

  const order = ["profile", "preference", "fact", "context"];
  const lines = [];
  for (const cat of order) {
    for (const r of rows.filter((x) => x.category === cat)) {
      if (excludeDocFacts && r.key.startsWith("doc_")) continue;
      lines.push(`- (${cat}) ${r.key.replace(/_/g, " ")}: ${r.value}`);
    }
  }

  let block = "";
  for (const line of lines) {
    if (block.length + line.length + 1 > budget) break;
    block += line + "\n";
  }
  if (!block) return "";

  return (
    "\n\nWHAT YOU KNOW ABOUT THIS USER (their private memory — use it to " +
    "personalize naturally; never recite this list, never mention 'memory' " +
    "unless they ask what you remember):\n" + block.trimEnd()
  );
}

module.exports = {
  remember,
  deleteByKey,
  listMemories,
  deleteMemory,
  clearMemories,
  seedProfile,
  buildMemoryPrompt,
  slugKey,
  MAX_PER_USER,
};
