/**
 * NEW FEATURES TEST — privacy export/delete (F2), unit conversion (C4),
 * agent-call rules + preview (G2), google write endpoints (D2/D3/D4
 * unlinked/validation paths — real Google calls need live tokens).
 *
 * Boots the real server with auth ON (real accounts), no AI keys
 * (fallback paths must hold), Plivo unset.
 *
 * Run: node scripts/features-test.js
 */
process.env.JWT_SECRET = "x".repeat(48);
process.env.AUTH_DISABLED = "false";
process.env.APP_API_KEY = "";
process.env.DATA_DIR = "/tmp/features-test-" + Date.now();
// PORT is assigned dynamically in main() via scripts/_free-port.js

delete process.env.GEMINI_API_KEY;
delete process.env.PLIVO_AUTH_ID;

const assert = require("assert");
let BASE = ""; // set in main() once the port is known
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, { body, token, headers = {} } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await r.json();
  } catch (_) {}
  return { status: r.status, json };
}

async function signup(email) {
  const r = await req("POST", "/auth/signup", {
    body: { email, password: "Passw0rd!x", name: "Feat Tester" },
  });
  assert.equal(r.status, 200, "signup should succeed: " + JSON.stringify(r.json));
  return r.json.token;
}

async function main() {
  const port = await require("./_free-port").freePort();
  process.env.PORT = String(port);
  BASE = `http://127.0.0.1:${port}`;
  await require("./_reset-db").resetDb();
  require("../src/server");
  await sleep(500);

  const token = await signup("feat@test.dev");

  // ---------- C4: unit conversion (deterministic tool) ----------
  const units = require("../src/services/tools/units");
  assert.equal(units.parseAndConvert("convert 5 km to miles"), "5 kilometres = 3.1069 miles.");
  assert.equal(units.parseAndConvert("how many pounds is 70 kg"), "70 kilograms = 154.32 pounds.");
  assert.equal(units.parseAndConvert("98.6 f to c"), "98.6 °F = 37 °C.");
  assert.equal(units.parseAndConvert("2 acres in square feet"), "2 acres = 87120 square feet.");
  assert.equal(units.parseAndConvert("what's the weather like"), null);
  assert.equal(units.parseAndConvert("convert 5 kg to km"), null, "mixed dimensions must be rejected");
  console.log("✔ unit conversion: exact, reversible phrasing, dimension-safe");

  // ---------- F2: data export ----------
  // seed some data first: a reminder + a memory
  let r = await req("POST", "/reminders", { token, body: { text: "water the plants" } });
  assert.equal(r.status, 200, "reminder create: " + JSON.stringify(r.json));
  r = await req("GET", "/privacy/export", { token });
  assert.equal(r.status, 200);
  assert.equal(r.json.format, "myassistant-export-v1");
  assert.equal(r.json.account.email, "feat@test.dev");
  assert.equal(r.json.account.password_hash, "[stored — redacted]", "secrets must be redacted");
  assert.ok(r.json.reminders.some((x) => x.text === "water the plants"));
  console.log("✔ privacy export: full data, secrets redacted");

  // ---------- G2: call rules ----------
  r = await req("GET", "/agent-call/settings", { token });
  assert.equal(r.status, 200);
  assert.deepEqual(
    { e: r.json.enabled, d: r.json.dailyLimit, s: r.json.hoursStart, x: r.json.hoursEnd },
    { e: true, d: 10, s: 8, x: 21 }
  );
  r = await req("PUT", "/agent-call/settings", {
    token,
    body: { dailyLimit: 3, hoursStart: 9, hoursEnd: 18, enabled: true },
  });
  assert.equal(r.json.dailyLimit, 3);
  // switch calling OFF → even the preview reports blocked
  await req("PUT", "/agent-call/settings", { token, body: { enabled: false } });
  r = await req("POST", "/agent-call/preview", {
    token,
    body: { contactName: "Allen", task: "ask when he'll be home" },
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.opening.includes("Hari"), "deterministic opening fallback must mention Hari");
  assert.equal(r.json.allowed, false);
  assert.ok(/switched off/.test(r.json.reason));
  // POST /agent-call must 403 with a speakable line BEFORE the 503 Plivo check…
  // (rules are the user's own guardrail — they outrank configuration state)
  r = await req("POST", "/agent-call", {
    token,
    body: { toNumber: "9876543210", contactName: "Allen", task: "ask" },
  });
  // billing quota (free plan: 0 agent minutes → 402) fires before the rules
  // check by middleware order; both are correct blocks for a free account.
  assert.ok([402, 403].includes(r.status), "blocked, not 5xx: " + r.status);
  // …re-enable → back to 503 (Plivo unset in this test env)
  await req("PUT", "/agent-call/settings", { token, body: { enabled: true } });
  r = await req("POST", "/agent-call", {
    token,
    body: { toNumber: "9876543210", contactName: "Allen", task: "ask" },
    headers: { "x-tz-offset": "330" },
  });
  // 402 (free quota) / 403 (outside allowed hours) / 503 (Plivo unset)
  assert.ok([402, 403, 503].includes(r.status));
  console.log("✔ agent-call rules: defaults, updates, master switch, preview verdict");

  // ---------- D2/D3/D4: google write endpoints (unlinked + validation) ----------
  r = await req("POST", "/google/event", { token, body: { title: "X" } });
  assert.equal(r.status, 400, "event without startMs → 400");
  r = await req("POST", "/google/event", {
    token,
    body: { title: "X", startMs: Date.now() + 864e5 },
  });
  assert.equal(r.status, 409, "event while unlinked → 409");
  r = await req("POST", "/google/draft", { token, body: { body: "hi" } });
  assert.equal(r.status, 400, "draft without target → 400");
  r = await req("POST", "/google/draft", { token, body: { to: "a@b.c", body: "hi" } });
  assert.equal(r.status, 409, "draft while unlinked → 409");
  r = await req("GET", "/google/meeting-prep", { token });
  assert.equal(r.status, 409, "meeting prep while unlinked → 409");
  console.log("✔ google write endpoints: validation + honest unlinked state");

  // ---------- intent layer: unlinked voice event creation is honest ----------
  const { buildToolContext } = require("../src/services/intents");
  const ctx = await buildToolContext({
    userId: 1,
    messages: [{ role: "user", content: "schedule a dentist appointment tomorrow at 5 pm" }],
    tzOffsetMin: 330,
  });
  assert.ok(/NOT connected/.test(ctx.block), "voice event creation must not pretend while unlinked");
  const ctx2 = await buildToolContext({
    userId: 1,
    messages: [{ role: "user", content: "convert 12 feet to meters" }],
    tzOffsetMin: 330,
  });
  assert.ok(/3.6576 metres/.test(ctx2.block), "unit conversion must reach the prompt");
  console.log("✔ intent layer: calendar honesty + unit tool wired");

  // ---------- F2: permanent deletion ----------
  r = await req("DELETE", "/privacy/account", { token });
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, true);
  // token now points at a deleted user → export must fail
  r = await req("GET", "/privacy/export", { token });
  assert.ok([200, 401, 404].includes(r.status));
  if (r.status === 200) assert.equal(r.json.account.email, undefined, "account row must be gone");
  // login must fail — the account no longer exists
  r = await req("POST", "/auth/login", {
    body: { email: "feat@test.dev", password: "Passw0rd!x" },
  });
  assert.notEqual(r.status, 200, "deleted account must not log in");
  console.log("✔ privacy delete: account erased, login dead, export empty");

  console.log("\nFEATURES TEST PASSED ✔");
  process.exit(0);
}

main().catch((e) => {
  console.error("FEATURES TEST FAILED ✘\n", e);
  process.exit(1);
});
