/**
 * INFRASTRUCTURE TESTS — background jobs, observability, flight provider.
 * Real PostgreSQL for the queue; no fabricated external results anywhere.
 */
const assert = require("assert");

process.env.GEMINI_API_KEY = "";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-at-least-32-characters-long!";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:55432/myassistant_test";
delete process.env.AMADEUS_CLIENT_ID;
delete process.env.AMADEUS_CLIENT_SECRET;
delete process.env.DUFFEL_API_TOKEN;

const db = require("../src/db");
const jobs = require("../src/infra/jobs");
const obs = require("../src/infra/observability");
const flights = require("../src/tools/flights");
const registry = require("../src/tools/registry");
require("../src/tools/builtins").registerBuiltins();

let pass = 0, fail = 0;
const QUEUE = [];
const test = (n, f) => QUEUE.push([n, f]);
async function drain() {
  for (const [n, f] of QUEUE) {
    try {
      await f();
      console.log("PASS  " + n);
      pass++;
    } catch (e) {
      console.log("FAIL  " + n + "\n      " + (e.stack || e.message).split("\n").slice(0, 3).join("\n      "));
      fail++;
    }
  }
}

async function setup() {
  await db.init();
  await db.run(`DELETE FROM jobs`);
}

/* ---------------- background jobs ---------------- */

test("a queued job runs and is marked done", async () => {
  let ran = null;
  jobs.register("test.echo", async (payload) => { ran = payload.value; });
  const id = await jobs.enqueue("test.echo", { value: 42 });
  const n = await jobs.drain();
  assert.ok(n >= 1, "drained at least one job");
  assert.strictEqual(ran, 42);
  const row = await db.one(`SELECT status FROM jobs WHERE id=$1`, [id]);
  assert.strictEqual(row.status, "done");
});

test("a failing job retries with backoff, then gives up", async () => {
  let attempts = 0;
  jobs.register("test.boom", async () => { attempts++; throw new Error("nope"); });
  const id = await jobs.enqueue("test.boom", {});
  for (let i = 0; i < 4; i++) {
    await db.run(`UPDATE jobs SET run_after=0 WHERE id=$1 AND status='pending'`, [id]);
    await jobs.drain();
  }
  const row = await db.one(`SELECT status, attempts, last_error FROM jobs WHERE id=$1`, [id]);
  assert.strictEqual(row.status, "failed", "stops retrying eventually");
  assert.ok(row.attempts >= 3, `retried, attempts=${row.attempts}`);
  assert.match(row.last_error, /nope/);
});

test("an unknown job kind fails cleanly instead of crashing the worker", async () => {
  const id = await jobs.enqueue("test.nohandler", {});
  await jobs.drain();
  const row = await db.one(`SELECT status, last_error FROM jobs WHERE id=$1`, [id]);
  assert.strictEqual(row.status, "failed");
  assert.match(row.last_error, /no handler/);
});

test("jobs survive a restart (persisted, not in-memory)", async () => {
  const id = await jobs.enqueue("test.echo", { value: 7 });
  const row = await db.one(`SELECT status FROM jobs WHERE id=$1`, [id]);
  assert.strictEqual(row.status, "pending", "still queued in the database");
  await jobs.drain();
});

test("claiming is concurrency-safe (no job runs twice)", async () => {
  let runs = 0;
  jobs.register("test.once", async () => { runs++; });
  await jobs.enqueue("test.once", {});
  // Two workers draining simultaneously, as two backend replicas would.
  await Promise.all([jobs.drain(), jobs.drain()]);
  assert.strictEqual(runs, 1, `ran exactly once, got ${runs}`);
});

/* ---------------- observability ---------------- */

test("logs redact credentials and truncate user content (§26)", () => {
  const out = obs.redact({
    authorization: "Bearer abc123",
    api_key: "sk-secret",
    nested: { refresh_token: "rt-1", city: "Mangalore" },
    text: "x".repeat(300),
  });
  assert.strictEqual(out.authorization, "[redacted]");
  assert.strictEqual(out.api_key, "[redacted]");
  assert.strictEqual(out.nested.refresh_token, "[redacted]");
  assert.strictEqual(out.nested.city, "Mangalore", "non-sensitive kept");
  assert.ok(out.text.length < 130, "long content truncated");
});

test("latency and counters are recorded", async () => {
  await obs.timed("test.op", async () => new Promise((r) => setTimeout(r, 15)));
  const snap = obs.snapshot();
  assert.ok(snap.latency["test.op"], "latency recorded");
  assert.ok(snap.latency["test.op"].avgMs >= 10);
  assert.strictEqual(snap.counters["test.op.ok"], 1);
});

test("a failed op is counted as an error and rethrown", async () => {
  await assert.rejects(() => obs.timed("test.bad", async () => { throw new Error("x"); }));
  assert.strictEqual(obs.snapshot().counters["test.bad.error"], 1);
});

/* ---------------- flights (§20, §32) ---------------- */

test("flight search is honest when no provider is configured", async () => {
  const r = await flights.search({ from: "Bangalore", to: "Delhi" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not configured/);
  assert.ok(!r.data, "no fabricated flights");
});

test("known cities resolve to airports; unknown ones are asked about", async () => {
  assert.strictEqual(flights.resolveAirport("Bangalore"), "BLR");
  assert.strictEqual(flights.resolveAirport("bengaluru"), "BLR");
  assert.strictEqual(flights.resolveAirport("DEL"), "DEL");
  assert.strictEqual(flights.resolveAirport("Springfield"), null, "not guessed");
});

test("search_flights tool is registered and reports the missing dependency", async () => {
  const res = await registry.execute(
    "search_flights", { from: "Bangalore", to: "Delhi" }, { userId: 1 }
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /not configured/);
});

/* ---------------- web search honesty ---------------- */

test("web search is honest when unconfigured (no fabricated results)", async () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.GOOGLE_CSE_KEY;
  const res = await registry.execute("web_search", { query: "nvidia" }, { userId: 1 });
  assert.strictEqual(res.ok, false);
  assert.ok(!res.data);
});

setup()
  .then(drain)
  .then(async () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    jobs.stop();
    await db.close();
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    console.error("SETUP FAILED:", e.stack || e.message);
    process.exit(1);
  });
