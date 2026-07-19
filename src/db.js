/**
 * USER STORE — SQLite via better-sqlite3 (synchronous, zero-config).
 * The DB file lives in DATA_DIR (default ./data) — mount a volume there
 * in Docker so accounts survive redeploys.
 */
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "myassistant.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE,
    name          TEXT,
    password_hash TEXT,
    provider      TEXT NOT NULL DEFAULT 'email',  -- email | google | apple
    provider_sub  TEXT,                            -- Google/Apple stable user id
    created_at    INTEGER NOT NULL,
    UNIQUE(provider, provider_sub)
  );
`);

const stmts = {
  byEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  byId: db.prepare("SELECT * FROM users WHERE id = ?"),
  byProviderSub: db.prepare(
    "SELECT * FROM users WHERE provider = ? AND provider_sub = ?"
  ),
  insert: db.prepare(`
    INSERT INTO users (email, name, password_hash, provider, provider_sub, created_at)
    VALUES (@email, @name, @password_hash, @provider, @provider_sub, @created_at)
  `),
  updateName: db.prepare("UPDATE users SET name = ? WHERE id = ?"),
};

function findByEmail(email) {
  return stmts.byEmail.get(email.toLowerCase());
}

function findById(id) {
  return stmts.byId.get(id);
}

function findByProvider(provider, sub) {
  return stmts.byProviderSub.get(provider, sub);
}

function createUser({ email, name, passwordHash = null, provider = "email", providerSub = null }) {
  const info = stmts.insert.run({
    email: email ? email.toLowerCase() : null,
    name: name || null,
    password_hash: passwordHash,
    provider,
    provider_sub: providerSub,
    created_at: Date.now(),
  });
  return findById(info.lastInsertRowid);
}

/** Find-or-create for social sign-in. Links by provider sub first, then email. */
function upsertSocialUser({ provider, sub, email, name }) {
  let user = findByProvider(provider, sub);
  if (user) {
    if (name && !user.name) {
      stmts.updateName.run(name, user.id);
      user = findById(user.id);
    }
    return user;
  }
  // Same email already registered (e.g. email signup first, Google later):
  // link the social identity to that account rather than duplicating it.
  if (email) {
    const existing = findByEmail(email);
    if (existing) {
      db.prepare("UPDATE users SET provider_sub = COALESCE(provider_sub, ?) WHERE id = ?")
        .run(sub, existing.id);
      return findById(existing.id);
    }
  }
  return createUser({ email, name, provider, providerSub: sub });
}

/** Shape sent to clients — never includes password_hash. */
function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, provider: u.provider };
}

module.exports = { findByEmail, findById, upsertSocialUser, createUser, publicUser };
