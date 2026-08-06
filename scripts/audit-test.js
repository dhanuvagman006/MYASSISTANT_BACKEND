/**
 * AUDIT LOG TEST (Phase 1, item 1.7 · ADR-004)
 * Boots the real server (auth ON, no AI keys) and verifies:
 *   • assistant actions write rows (reminder create/delete as the exemplar)
 *   • GET /actions is newest-first, cursor-paged, and per-user isolated
 *   • /privacy/export includes actions_log
 *   • DELETE /privacy/account erases the log
 *   • a broken audit write never breaks the action itself (fail-open)
 *
 * Run: node scripts/audit-test.js   (needs DATABASE_URL like the smoke test)
 */
process.env.JWT_SECRET = "x".repeat(48);
process.env.AUTH_DISABLED = "false";
process.env.APP_API_KEY = "";
process.env.DATA_DIR = "/tmp/audit-test-" + Date.now();
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;

const assert = require("assert");
let BASE = "";

async function req(method, path, { body, token } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, json };
}

async function signup(email) {
  const r = await req("POST", "/auth/signup", {
    body: { email, password: "pass-word-123", name: "Audit Tester" },
  });
  assert.strictEqual(r.status, 200, "signup: " + JSON.stringify(r.json));
  return r.json.token;
}

let pass = 0;
function ok(name) { console.log("  ✓ " + name); pass++; }

async function main() {
  process.env.PORT = String(await require("./_free-port").freePort());
  require("../src/server");
  BASE = "http://127.0.0.1:" + process.env.PORT;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + "/health")).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const t = Date.now();
  const tokenA = await signup(`audit-a-${t}@test.local`);
  const tokenB = await signup(`audit-b-${t}@test.local`);

  // -- actions write rows, newest first --------------------------------
  const ids = [];
  for (const text of ["buy milk", "call amma", "pay rent"]) {
    const r = await req("POST", "/reminders", { token: tokenA, body: { text } });
    assert.strictEqual(r.status, 200);
    ids.push(r.json.reminder.id);
  }
  let log = await req("GET", "/actions", { token: tokenA });
  assert.strictEqual(log.status, 200);
  assert.strictEqual(log.json.actions.length, 3);
  assert.strictEqual(log.json.actions[0].action, "reminder.created");
  assert.strictEqual(log.json.actions[0].detail, "pay rent"); // newest first
  assert.strictEqual(log.json.actions[2].detail, "buy milk");
  assert.ok(Number.isFinite(log.json.actions[0].created_at));
  ok("assistant actions write rows, newest first");

  // -- delete is audited too -------------------------------------------
  await req("DELETE", "/reminders/" + ids[0], { token: tokenA });
  log = await req("GET", "/actions", { token: tokenA });
  assert.strictEqual(log.json.actions[0].action, "reminder.deleted");
  ok("destructive actions are audited");

  // -- cursor paging ----------------------------------------------------
  const page1 = await req("GET", "/actions?limit=2", { token: tokenA });
  assert.strictEqual(page1.json.actions.length, 2);
  const page2 = await req(
    "GET", "/actions?limit=10&before=" + page1.json.next_before, { token: tokenA });
  assert.strictEqual(page2.json.actions.length, 2); // 4 total: 3 creates + 1 delete
  const allIds = [...page1.json.actions, ...page2.json.actions].map((a) => a.id);
  assert.strictEqual(new Set(allIds).size, 4, "pages must not overlap");
  ok("cursor paging: complete, non-overlapping");

  // -- per-user isolation ----------------------------------------------
  const logB = await req("GET", "/actions", { token: tokenB });
  assert.strictEqual(logB.json.actions.length, 0);
  ok("users only see their own log");

  // -- unauthenticated is rejected -------------------------------------
  assert.strictEqual((await req("GET", "/actions")).status, 401);
  ok("no token → 401");

  // -- privacy export includes the log ---------------------------------
  const exp = await req("GET", "/privacy/export", { token: tokenA });
  assert.strictEqual(exp.status, 200);
  assert.ok(Array.isArray(exp.json.actions_log), "export must contain actions_log");
  assert.strictEqual(exp.json.actions_log.length, 4);
  ok("/privacy/export includes actions_log");

  // -- fail-open: audit failure never breaks the action ----------------
  const audit = require("../src/audit/log");
  await audit.record("not-a-number", "x.y", "dev sessions are skipped, no throw");
  const r = await req("POST", "/reminders", { token: tokenA, body: { text: "still works" } });
  assert.strictEqual(r.status, 200);
  ok("audit is fail-open: bad uid is a no-op, actions continue");

  // -- account erasure removes the log ---------------------------------
  const del = await req("DELETE", "/privacy/account", {
    token: tokenA, body: { confirm: "DELETE" },
  });
  assert.ok(del.status === 200, "account delete: " + JSON.stringify(del.json));
  const { query } = require("../src/db");
  // tokenA is dead now; check the table directly for any orphan rows.
  const orphans = await query(
    "SELECT COUNT(*)::int AS n FROM actions_log l WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id)"
  );
  assert.strictEqual(orphans[0].n, 0, "erasure must remove audit rows");
  ok("account erasure removes the audit log");

  console.log(`audit-test: ${pass}/8 passed`);
  process.exit(0);
}

main().catch((e) => { console.error("AUDIT TEST FAILED:", e); process.exit(1); });
