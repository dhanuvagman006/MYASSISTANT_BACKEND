/**
 * PER-USER MEMORY STORE
 * ---------------------
 * Long-term facts about each user that make the assistant personal.
 * Three writers, one table:
 *   source='signup' — profile facts seeded from Google/Apple/email sign-up
 *   source='ai'     — durable facts the extractor learns from conversations
 *   source='user'   — facts the user adds/edits themselves in the app
 *
 * Design rules:
 *   • (user_id, key) is UNIQUE → saving the same key UPDATES the fact
 *     ("favorite_team: RCB" replaces the old value, never duplicates).
 *   • Hard cap per user (MAX_PER_USER). When full, the oldest AI-learned
 *     fact is evicted first — signup/user facts are never auto-evicted.
 *   • Everything here is plain rows the user can list and delete
 *     via /memory — no hidden state.
 */
const { db } = require("../db");

const MAX_PER_USER = 200;
const CATEGORIES = new Set(["profile", "preference", "fact", "context"]);

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    category   TEXT NOT NULL DEFAULT 'fact',   -- profile | preference | fact | context
    key        TEXT NOT NULL,                  -- machine key, e.g. 'favorite_food'
    value      TEXT NOT NULL,                  -- human sentence/value
    source     TEXT NOT NULL DEFAULT 'ai',     -- signup | ai | user
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, key)
  );
  CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
`);

const stmts = {
  list: db.prepare(
    "SELECT * FROM memories WHERE user_id = ? ORDER BY category, updated_at DESC"
  ),
  count: db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ?"),
  upsert: db.prepare(`
    INSERT INTO memories (user_id, category, key, value, source, created_at, updated_at)
    VALUES (@user_id, @category, @key, @value, @source, @now, @now)
    ON CONFLICT(user_id, key) DO UPDATE SET
      value = excluded.value,
      category = excluded.category,
      updated_at = excluded.updated_at
  `),
  delete: db.prepare("DELETE FROM memories WHERE user_id = ? AND id = ?"),
  clear: db.prepare("DELETE FROM memories WHERE user_id = ?"),
  evictOldestAi: db.prepare(`
    DELETE FROM memories WHERE id IN (
      SELECT id FROM memories WHERE user_id = ? AND source = 'ai'
      ORDER BY updated_at ASC LIMIT 1
    )
  `),
};

/** 'Favorite food' / 'favorite-food' / ' Favorite  Food ' → 'favorite_food' */
function slugKey(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/**
 * Save (insert-or-update) one memory. Returns the saved row or null if
 * the input was unusable. Safe to call with untrusted AI output.
 */
function remember(userId, { key, value, category = "fact", source = "ai" }) {
  const k = slugKey(key);
  const v = String(value || "").trim().slice(0, 500);
  if (!k || !v) return null;
  const cat = CATEGORIES.has(category) ? category : "fact";

  // Enforce the cap only for NEW keys (updates never grow the table).
  const exists = db
    .prepare("SELECT 1 FROM memories WHERE user_id = ? AND key = ?")
    .get(userId, k);
  if (!exists && stmts.count.get(userId).n >= MAX_PER_USER) {
    stmts.evictOldestAi.run(userId); // ai facts churn; signup/user facts stay
    if (stmts.count.get(userId).n >= MAX_PER_USER) return null; // all protected
  }

  stmts.upsert.run({
    user_id: userId, category: cat, key: k, value: v, source,
    now: Date.now(),
  });
  return db.prepare("SELECT * FROM memories WHERE user_id = ? AND key = ?").get(userId, k);
}

function listMemories(userId) {
  return stmts.list.all(userId);
}

function deleteMemory(userId, id) {
  return stmts.delete.run(userId, id).changes > 0;
}

function clearMemories(userId) {
  return stmts.clear.run(userId).changes;
}

/**
 * Seed profile memories at sign-up (or first social sign-in).
 * Called from routes/auth.js with whatever the identity provider gave us.
 * Never overwrites AI/user facts because keys are namespaced 'profile.*'-style.
 */
function seedProfile(userId, { name, givenName, email, picture, locale } = {}) {
  const put = (key, value) =>
    value && remember(userId, { key, value, category: "profile", source: "signup" });
  put("profile_name", name);
  put("profile_given_name", givenName);
  put("profile_email", email);
  put("profile_picture", picture);
  if (locale) put("profile_locale", locale);
}

/**
 * Render memories as a system-prompt block the AI reads on every reply.
 * Kept compact: category-grouped one-liners, hard character budget so a
 * memory-heavy user can never blow up the context window.
 */
function buildMemoryPrompt(userId, { budget = 2200 } = {}) {
  const rows = listMemories(userId);
  if (rows.length === 0) return "";

  const order = ["profile", "preference", "fact", "context"];
  const lines = [];
  for (const cat of order) {
    for (const r of rows.filter((x) => x.category === cat)) {
      if (r.key === "profile_picture") continue; // URL — useless to the model
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
  listMemories,
  deleteMemory,
  clearMemories,
  seedProfile,
  buildMemoryPrompt,
  slugKey,
  MAX_PER_USER,
};
