/**
 * BACKGROUND JOBS (§25) — durable, in-process worker.
 *
 * OCR, embedding and document indexing must not block a live voice turn.
 * Jobs are persisted in PostgreSQL rather than held in memory, so a
 * restart mid-document does not silently lose the work.
 *
 * WHY NOT REDIS/BullMQ: Redis is not part of the current deployment, and
 * adding a broker the environment doesn't run would be a fake dependency.
 * The table-backed queue below uses SELECT … FOR UPDATE SKIP LOCKED, which
 * is safe across MULTIPLE backend instances — so this scales horizontally
 * as-is, and swapping in BullMQ later means reimplementing `claim()` only.
 */
const { query, one, run } = require("../db");
const { logger, timed, count } = require("./observability");

const HANDLERS = new Map();
let timer = null;
let running = false;

const POLL_MS = Number(process.env.JOB_POLL_MS) || 2000;
const MAX_ATTEMPTS = 3;

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER,
      kind        TEXT NOT NULL,
      payload     JSONB NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT NOT NULL DEFAULT '',
      run_after   BIGINT NOT NULL,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_claim
      ON jobs(status, run_after) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, id DESC);
  `);
}

function register(kind, handler) {
  HANDLERS.set(kind, handler);
}

async function enqueue(kind, payload = {}, { userId = null, delayMs = 0 } = {}) {
  const t = Date.now();
  const row = await one(
    `INSERT INTO jobs (user_id,kind,payload,run_after,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
    [userId, kind, JSON.stringify(payload), t + delayMs, t]
  );
  count(`jobs.enqueued.${kind}`);
  return Number(row.id);
}

/**
 * Claims one job atomically. SKIP LOCKED means two backend instances never
 * pick up the same row, so this is safe to run on every replica.
 */
async function claim() {
  const rows = await query(
    `UPDATE jobs SET status='running', attempts=attempts+1, updated_at=$1
      WHERE id = (
        SELECT id FROM jobs
         WHERE status='pending' AND run_after <= $1
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
    [Date.now()]
  );
  return rows[0] || null;
}

async function runOne() {
  const job = await claim();
  if (!job) return false;

  const handler = HANDLERS.get(job.kind);
  if (!handler) {
    await run(
      `UPDATE jobs SET status='failed', last_error=$2, updated_at=$3 WHERE id=$1`,
      [job.id, `no handler for "${job.kind}"`, Date.now()]
    );
    logger.warn("job_no_handler", { id: Number(job.id), kind: job.kind });
    return true;
  }

  try {
    await timed(`job.${job.kind}`, () => handler(job.payload, job), {
      jobId: Number(job.id),
    });
    await run(`UPDATE jobs SET status='done', updated_at=$2 WHERE id=$1`, [
      job.id, Date.now(),
    ]);
  } catch (e) {
    const give_up = job.attempts >= MAX_ATTEMPTS;
    // Exponential backoff; a permanently broken job stops retrying rather
    // than spinning forever.
    await run(
      `UPDATE jobs SET status=$2, last_error=$3, run_after=$4, updated_at=$5 WHERE id=$1`,
      [
        job.id,
        give_up ? "failed" : "pending",
        String(e.message).slice(0, 300),
        Date.now() + Math.min(60_000, 2000 * 2 ** job.attempts),
        Date.now(),
      ]
    );
    logger.error("job_failed", {
      id: Number(job.id), kind: job.kind, attempts: job.attempts,
      willRetry: !give_up, error: e.message,
    });
  }
  return true;
}

/** Drains the queue; used by tests and by the poller. */
async function drain(max = 50) {
  let n = 0;
  while (n < max && (await runOne())) n++;
  return n;
}

function start() {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return; // never overlap polls
    running = true;
    try {
      await drain(10);
    } catch (e) {
      logger.error("job_poll_failed", { error: e.message });
    } finally {
      running = false;
    }
  }, POLL_MS);
  if (timer.unref) timer.unref();
  logger.info("jobs_started", { pollMs: POLL_MS, handlers: [...HANDLERS.keys()] });
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { migrate, register, enqueue, drain, runOne, start, stop, HANDLERS };
