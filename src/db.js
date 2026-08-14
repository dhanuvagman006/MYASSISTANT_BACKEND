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

    -- AGENT MEMORY (multi-agent phase): durable per-user facts the
    -- conversational agent has learned ("name is Dhanya", "vegetarian",
    -- "exam on the 20th"). Injected into every agent's prompt AND the
    -- D-ID face bridge — the assistant is one continuous person.
    -- Wiped by account deletion; exported by /privacy/export.
    CREATE TABLE IF NOT EXISTS agent_memories (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      fact       TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 2,   -- 3 identity/health, 2 prefs, 1 minor
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_user
      ON agent_memories(user_id, importance DESC, id DESC);

    -- BOOKINGS (booking agent): the user's booking ledger. A reminder
    -- row is created one hour before when_at. status: confirmed|cancelled.
    CREATE TABLE IF NOT EXISTS bookings (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'other', -- restaurant|doctor|travel|salon|other
      title      TEXT NOT NULL,
      venue      TEXT,
      party_size INTEGER,
      when_at    BIGINT,                        -- epoch ms; NULL = undated
      notes      TEXT,
      status     TEXT NOT NULL DEFAULT 'confirmed',
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_user
      ON bookings(user_id, status, when_at);

    CREATE TABLE IF NOT EXISTS google_tokens (
      user_id       INTEGER PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token  TEXT,
      expires_at    BIGINT,
      scopes        TEXT,
      updated_at    BIGINT NOT NULL
    );
    -- Semantic recall (Aug 2026): 768-dim gemini-embedding-001 vector stored
    -- as a JSON array string; NULL until backfilled. Cosine ranking happens
    -- in Node (≤200 rows/user), so no pgvector extension is required.

    -- /assistant call-and-inform: when the opening message was rendered
    -- with the user's enrolled/cloned voice (ElevenLabs), this holds the
    -- public mp3 URL that Plivo <Play>s instead of carrier TTS.
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

    -- CLIENTS / PATIENTS (professional mode, Aug 2026): a doctor, lawyer,
    -- CA… keeps a per-person case file. Documents link to a client via
    -- documents.client_id; dated case notes live in client_notes. Voice
    -- recall ("pull up patient Ramesh's file") reads all three together.
    -- User-visible, user-deletable, exported by /privacy/export and wiped
    -- by account erasure — same contract as documents and memories.
    CREATE TABLE IF NOT EXISTS clients (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'client',  -- patient | client | student | customer | other
      phone      TEXT NOT NULL DEFAULT '',
      email      TEXT NOT NULL DEFAULT '',
      summary    TEXT NOT NULL DEFAULT '',        -- one-line profile ("42M, diabetic" / "Property dispute, Sy.No 12")
      tags       TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id, updated_at DESC);

    -- Dated case/visit notes ("note for patient Ramesh: allergic to
    -- penicillin"). Append-style; each note keeps its own timestamp so
    -- the profile reads as a timeline.
    CREATE TABLE IF NOT EXISTS client_notes (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      client_id  BIGINT NOT NULL,
      text       TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_client_notes ON client_notes(user_id, client_id, id DESC);

    -- Migration: link documents to a client (NULL = personal document).
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS client_id BIGINT;
    CREATE INDEX IF NOT EXISTS idx_docs_client ON documents(user_id, client_id, created_at DESC);
  `);

  // PHASE 2: entity + memory model (people widened, cases, document links,
  // typed/correctable memories, events, conversation history). Runs after
  // the base schema because it ALTERs clients/agent_memories.
  await require("./memory/schema").migrate((sql) => pool.query(sql));

  // MCP server registry (per-user external capabilities, credentials
  // encrypted at rest).
  await require("./mcp/schema").migrate((sql) => pool.query(sql));

  // Document intelligence: chunk + embedding store for semantic retrieval.
  await require("./docs/intelligence").migrate((sql) => pool.query(sql));

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
