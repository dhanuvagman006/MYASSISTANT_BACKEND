/**
 * PER-USER REMINDERS
 * ------------------
 * Created two ways: voice ("remind me to call amma tomorrow at 5" via the
 * intent layer in /chat) and the Today screen's + button. The app syncs
 * this list and schedules local notifications for every future due_at.
 */
const { db } = require("../db");

db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    text       TEXT NOT NULL,
    due_at     INTEGER,            -- epoch ms; NULL = undated note-to-self
    done       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id, done, due_at);
`);

const stmts = {
  list: db.prepare(
    `SELECT * FROM reminders WHERE user_id = ?
     ORDER BY done ASC, due_at IS NULL, due_at ASC, created_at DESC LIMIT 200`
  ),
  insert: db.prepare(
    "INSERT INTO reminders (user_id, text, due_at, created_at) VALUES (?, ?, ?, ?)"
  ),
  byId: db.prepare("SELECT * FROM reminders WHERE user_id = ? AND id = ?"),
  setDone: db.prepare("UPDATE reminders SET done = ? WHERE user_id = ? AND id = ?"),
  update: db.prepare(
    "UPDATE reminders SET text = ?, due_at = ? WHERE user_id = ? AND id = ?"
  ),
  delete: db.prepare("DELETE FROM reminders WHERE user_id = ? AND id = ?"),
};

function list(userId) {
  return stmts.list.all(userId);
}

function create(userId, text, dueAt = null) {
  const t = String(text || "").trim().slice(0, 300);
  if (!t) return null;
  const info = stmts.insert.run(userId, t, dueAt || null, Date.now());
  return stmts.byId.get(userId, info.lastInsertRowid);
}

function setDone(userId, id, done) {
  return stmts.setDone.run(done ? 1 : 0, userId, id).changes > 0;
}

function update(userId, id, text, dueAt) {
  const cur = stmts.byId.get(userId, id);
  if (!cur) return null;
  stmts.update.run(
    text != null ? String(text).trim().slice(0, 300) : cur.text,
    dueAt !== undefined ? dueAt : cur.due_at,
    userId,
    id
  );
  return stmts.byId.get(userId, id);
}

function remove(userId, id) {
  return stmts.delete.run(userId, id).changes > 0;
}

/** Compact upcoming list for AI context / spoken briefings. */
function upcomingText(userId, { max = 8 } = {}) {
  const rows = list(userId).filter((r) => !r.done).slice(0, max);
  if (rows.length === 0) return "";
  return rows
    .map((r) => {
      const when = r.due_at
        ? new Date(r.due_at).toISOString()
        : "no set time";
      return `- [id ${r.id}] ${r.text} (due ${when})`;
    })
    .join("\n");
}

module.exports = { list, create, setDone, update, remove, upcomingText };
