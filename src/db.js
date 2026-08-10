/**
 * USER STORE + DB CORE — PostgreSQL via pg (async, pooled).
 *
 * Why Postgres (was better-sqlite3): SQLite allows exactly ONE writer
 * process, which pinned the Deployment to a single replica. Postgres
 * supports many concurrent writers → the k8s HPA can finally scale the
 * backend horizontally.
 *
 * Env: DATABASE_URL, e.g. postgres://user:pass@host:5432/myassistant
 *
 * ALL table schemas live here in init() — one place to read the whole
 * data model, and stores never race each other creating tables.
 * server.js awaits init() before listening.
 */
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL must be set (postgres://user:pass@host:5432/db)");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_SIZE || 10),
  idleTimeoutMillis: 30_000,
});

pool.on("error", (e) => console.error("pg pool error:", e.message));

/** All rows. */
async function query(text, params = []) {
  return (await pool.query(text, params)).rows;
}
/** First row or null. */
async function one(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}
/** Row count of an INSERT/UPDATE/DELETE. */
async function run(text, params = []) {
  return (await pool.query(text, params)).rowCount;
}
/** Callback receives a client inside BEGIN…COMMIT (ROLLBACK on throw). */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Create every table the app uses. Idempotent; runs once at boot. */
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE,
      name          TEXT,
      password_hash TEXT,
      provider      TEXT NOT NULL DEFAULT 'email',  -- email | google | apple
      provider_sub  TEXT,                            -- Google/Apple stable user id
      created_at    BIGINT NOT NULL,
      gender        TEXT,   -- 'male' | 'female' | 'other' | NULL (unset)
      UNIQUE(provider, provider_sub)
    );

    -- Migration for databases created before the gender column existed.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;

    -- AUDIT LOG (Phase 1 / ADR-004): one row for every action the assistant
    -- performs on the user's behalf that touches the outside world or
    -- destroys data. The privacy dashboard reads it; /privacy/export includes
    -- it; account erasure removes it (it is the user's data). Append-only by
    -- convention — no UPDATE/DELETE path exists in application code.
    CREATE TABLE IF NOT EXISTS actions_log (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      action     TEXT NOT NULL,          -- e.g. 'reminder.created', 'food.order.placed'
      detail     TEXT,                   -- short human-readable summary, no secrets
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_actions_user ON actions_log(user_id, id DESC);

    CREATE TABLE IF NOT EXISTS reminders (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      text       TEXT NOT NULL,
      due_at     BIGINT,             -- epoch ms; NULL = undated note-to-self
      done       INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id, done, due_at);

    CREATE TABLE IF NOT EXISTS google_tokens (
      user_id       INTEGER PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token  TEXT,
      expires_at    BIGINT,
      scopes        TEXT,
      updated_at    BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      category   TEXT NOT NULL DEFAULT 'fact',
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'ai',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE(user_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
    -- Semantic recall (Aug 2026): 768-dim gemini-embedding-001 vector stored
    -- as a JSON array string; NULL until backfilled. Cosine ranking happens
    -- in Node (≤200 rows/user), so no pgvector extension is required.
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding TEXT;

    CREATE TABLE IF NOT EXISTS agent_calls (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      contact_name     TEXT NOT NULL,
      to_number        TEXT NOT NULL,
      task             TEXT NOT NULL,
      lang             TEXT NOT NULL DEFAULT 'en-IN',
      state            TEXT NOT NULL DEFAULT 'queued',
      transcript       TEXT NOT NULL DEFAULT '[]',
      result           TEXT,
      provider_call_id TEXT,
      created_at       BIGINT NOT NULL,
      updated_at       BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_calls_user
      ON agent_calls (user_id, created_at DESC);

    -- /assistant call-and-inform: when the opening message was rendered
    -- with the user's enrolled/cloned voice (ElevenLabs), this holds the
    -- public mp3 URL that Plivo <Play>s instead of carrier TTS.
    ALTER TABLE agent_calls ADD COLUMN IF NOT EXISTS opening_audio_url TEXT;

    CREATE TABLE IF NOT EXISTS agent_call_settings (
      user_id     TEXT PRIMARY KEY,
      enabled     INTEGER NOT NULL DEFAULT 1,
      daily_limit INTEGER NOT NULL DEFAULT 10,
      hours_start INTEGER NOT NULL DEFAULT 8,
      hours_end   INTEGER NOT NULL DEFAULT 21
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id      TEXT PRIMARY KEY,
      plan         TEXT NOT NULL,
      period_end   BIGINT NOT NULL,
      last_payment TEXT,
      updated_at   BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage (
      user_id TEXT NOT NULL,
      kind    TEXT NOT NULL,
      period  TEXT NOT NULL,
      count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, kind, period)
    );
    CREATE TABLE IF NOT EXISTS families (
      id         SERIAL PRIMARY KEY,
      owner_id   TEXT NOT NULL UNIQUE,
      code       TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS family_members (
      family_id  INTEGER NOT NULL,
      user_id    TEXT NOT NULL UNIQUE,
      joined_at  BIGINT NOT NULL,
      PRIMARY KEY (family_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS payments (
      payment_id TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      plan       TEXT NOT NULL,
      amount     INTEGER NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS swiggy_tokens (
      user_id       INTEGER PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token  TEXT,
      expires_at    BIGINT,
      updated_at    BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      filename   TEXT NOT NULL,
      mime       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      path       TEXT NOT NULL,
      title      TEXT NOT NULL DEFAULT '',
      category   TEXT NOT NULL DEFAULT 'other',
      doc_date   TEXT NOT NULL DEFAULT '',
      summary    TEXT NOT NULL DEFAULT '',
      note       TEXT NOT NULL DEFAULT '',
      tags       TEXT NOT NULL DEFAULT '',
      full_text  TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL,
      -- Full-text search (was SQLite FTS5): auto-maintained tsvector over
      -- the same five fields, GIN-indexed. 'simple' config = plain word
      -- matching, closest to FTS5 unicode61 for mixed-language content.
      fts tsvector GENERATED ALWAYS AS (
        to_tsvector('simple',
          coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' ||
          coalesce(note,'')  || ' ' || coalesce(tags,'')    || ' ' ||
          coalesce(filename,'')
        )
      ) STORED
    );
    CREATE INDEX IF NOT EXISTS idx_docs_user ON documents(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_docs_fts ON documents USING GIN (fts);
  `);
  // SERIAL ids come back from pg as integers; BIGINT columns come back as
  // strings by default — parse them so Date-math keeps working.
  const types = require("pg").types;
  types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8 → number
}

async function close() {
  await pool.end();
}

// ---------------- users ----------------

async function findByEmail(email) {
  return one("SELECT * FROM users WHERE email = $1", [String(email).toLowerCase()]);
}

async function findById(id) {
  return one("SELECT * FROM users WHERE id = $1", [Number(id)]);
}

async function findByProvider(provider, sub) {
  return one("SELECT * FROM users WHERE provider = $1 AND provider_sub = $2", [provider, sub]);
}

async function createUser({ email, name, passwordHash = null, provider = "email", providerSub = null, gender = null }) {
  return one(
    `INSERT INTO users (email, name, password_hash, provider, provider_sub, created_at, gender)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [email ? email.toLowerCase() : null, name || null, passwordHash, provider, providerSub, Date.now(), gender]
  );
}

const GENDERS = new Set(["male", "female", "other"]);

/** Normalize a client-supplied gender; anything unknown becomes null. */
function cleanGender(g) {
  const v = typeof g === "string" ? g.trim().toLowerCase() : "";
  return GENDERS.has(v) ? v : null;
}

async function setGender(userId, gender) {
  await run("UPDATE users SET gender = $1 WHERE id = $2", [cleanGender(gender), Number(userId)]);
  return findById(userId);
}

/** Find-or-create for social sign-in. Links by provider sub first, then email.
 *  Returns { user, created } — `created` marks a brand-new account so the
 *  app can run the sign-up interview exactly once. */
async function upsertSocialUser({ provider, sub, email, name }) {
  let user = await findByProvider(provider, sub);
  if (user) {
    if (name && !user.name) {
      await run("UPDATE users SET name = $1 WHERE id = $2", [name, user.id]);
      user = await findById(user.id);
    }
    return { user, created: false };
  }
  // Same email already registered (e.g. email signup first, Google later):
  // link the social identity to that account rather than duplicating it.
  if (email) {
    const existing = await findByEmail(email);
    if (existing) {
      await run(
        "UPDATE users SET provider_sub = COALESCE(provider_sub, $1) WHERE id = $2",
        [sub, existing.id]
      );
      return { user: await findById(existing.id), created: false };
    }
  }
  return { user: await createUser({ email, name, provider, providerSub: sub }), created: true };
}

/** Shape sent to clients — never includes password_hash. */
function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, provider: u.provider, gender: u.gender || null };
}

module.exports = {
  pool, query, one, run, tx, init, close,
  findByEmail, findById, upsertSocialUser, createUser, publicUser,
  cleanGender, setGender,
};
