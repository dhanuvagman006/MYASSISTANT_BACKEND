/**
 * BILLING & ENFORCEMENT TEST — plans, metering, caps, Razorpay webhook
 * (signature + idempotency), families with pooled minutes, admin stats.
 * Boots the real server; AUTH is enabled with a REAL user (signed up via
 * /auth) so enforcement paths run exactly as in production.
 *
 * Run: node scripts/billing-test.js
 */
process.env.JWT_SECRET = "x".repeat(48);
process.env.AUTH_DISABLED = "false";
process.env.ALLOW_APP_KEY = "false";
process.env.DATA_DIR = "/tmp/billing-test-" + Date.now();
// PORT is assigned dynamically in main() via scripts/_free-port.js
process.env.RAZORPAY_KEY_ID = "rzp_test_x";
process.env.RAZORPAY_KEY_SECRET = "secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";
process.env.ADMIN_KEY = "admin-key-16-chars-min";
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;

const assert = require("assert");
const crypto = require("crypto");
let BASE = ""; // set in main() once the port is known
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { body, token, headers = {}, raw } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      ...(raw ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

async function signup(email) {
  const r = await api("POST", "/auth/signup", {
    body: { email, password: "correct-horse-9", name: email.split("@")[0] },
  });
  assert.strictEqual(r.status, 200, `signup ${email}: ${r.text}`);
  return { token: r.json.token, id: r.json.user.id };
}

function webhookBody(userId, plan, paymentId) {
  return JSON.stringify({
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { notes: { userId: String(userId), plan }, amount: 24900, id: "pl_" + paymentId } },
      payment: { entity: { id: paymentId } },
    },
  });
}
const sign = (raw) =>
  crypto.createHmac("sha256", "whsec_test").update(raw).digest("hex");

async function main() {
  const port = await require("./_free-port").freePort();
  process.env.PORT = String(port);
  BASE = `http://127.0.0.1:${port}`;
  await require("./_reset-db").resetDb();
  require("../src/server");
  await sleep(500);

  const u1 = await signup("owner@test.dev");
  const u2 = await signup("member@test.dev");
  console.log("✔ real accounts created (auth ON, no dev bypass)");

  // 1) Fresh user = free plan with the documented limits.
  let r = await api("GET", "/billing", { token: u1.token });
  assert.strictEqual(r.json.plan, "free");
  assert.strictEqual(r.json.usage.chat.limit, 20);
  assert.strictEqual(r.json.usage.agent_min.limit, 0);
  console.log("✔ GET /billing: free plan, limits visible");

  // 2) Free user: agent calls are refused with a clean 402 upsell.
  r = await api("POST", "/agent-call", {
    token: u1.token,
    body: { toNumber: "9876543210", contactName: "Allen", task: "ask x" },
  });
  assert.strictEqual(r.status, 402);
  assert.strictEqual(r.json.code, "limit_reached");
  console.log("✔ free user: agent call → 402 limit_reached (not 5xx)");

  // 3) Chat metering: free cap = 20/day → the 21st call is 402.
  //    (No AI keys set: allowed requests fail later with 502 — the
  //    metering decision happens BEFORE the provider call, which is
  //    exactly what we're testing.)
  let statuses = [];
  for (let i = 0; i < 21; i++) {
    r = await api("POST", "/chat", {
      token: u1.token,
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    statuses.push(r.status);
  }
  assert.ok(!statuses.slice(0, 20).includes(402), "first 20 chats must pass the gate");
  assert.strictEqual(statuses[20], 402, "21st chat must hit the cap");
  console.log("✔ chat metering: 20 allowed, 21st → 402");

  // 4) Webhook: bad signature rejected; good signature activates Pro.
  let raw = webhookBody(u1.id, "pro", "pay_A1");
  r = await api("POST", "/billing/webhook", {
    raw, headers: { "content-type": "application/json", "X-Razorpay-Signature": "nope" },
  });
  assert.strictEqual(r.status, 403);
  r = await api("POST", "/billing/webhook", {
    raw, headers: { "content-type": "application/json", "X-Razorpay-Signature": sign(raw) },
  });
  assert.strictEqual(r.status, 200);
  r = await api("GET", "/billing", { token: u1.token });
  assert.strictEqual(r.json.plan, "pro");
  assert.ok(r.json.periodEnd > Date.now() + 29 * 86400e3);
  console.log("✔ Razorpay webhook: bad sig 403, good sig → Pro active 31d");

  // 5) Pro user: chat is unlimited (the 402 wall is gone).
  r = await api("POST", "/chat", {
    token: u1.token,
    body: { messages: [{ role: "user", content: "hi" }] },
  });
  assert.notStrictEqual(r.status, 402);
  console.log("✔ pro user: chat cap lifted");

  // 6) Idempotency: replaying the same payment does NOT extend again.
  const before = (await api("GET", "/billing", { token: u1.token })).json.periodEnd;
  await api("POST", "/billing/webhook", {
    raw, headers: { "content-type": "application/json", "X-Razorpay-Signature": sign(raw) },
  });
  const after = (await api("GET", "/billing", { token: u1.token })).json.periodEnd;
  assert.strictEqual(before, after, "duplicate webhook must be a no-op");
  // …but a NEW payment (renewal) extends from the current expiry.
  raw = webhookBody(u1.id, "pro", "pay_A2");
  await api("POST", "/billing/webhook", {
    raw, headers: { "content-type": "application/json", "X-Razorpay-Signature": sign(raw) },
  });
  const renewed = (await api("GET", "/billing", { token: u1.token })).json.periodEnd;
  assert.ok(renewed > after + 29 * 86400e3, "renewal must extend from expiry");
  console.log("✔ payments idempotent; renewals stack onto expiry");

  // 7) Family: owner upgrades to family, invites, member inherits it.
  raw = webhookBody(u1.id, "family", "pay_F1");
  await api("POST", "/billing/webhook", {
    raw, headers: { "content-type": "application/json", "X-Razorpay-Signature": sign(raw) },
  });
  r = await api("POST", "/billing/family/invite", { token: u1.token });
  assert.strictEqual(r.status, 200);
  const code = r.json.code;
  assert.match(code, /^[A-Z2-9]{6}$/);
  r = await api("POST", "/billing/family/join", { token: u2.token, body: { code } });
  assert.strictEqual(r.status, 200);
  r = await api("GET", "/billing", { token: u2.token });
  assert.strictEqual(r.json.plan, "family");
  assert.strictEqual(r.json.via, "family");
  console.log("✔ family: invite code → member inherits the plan");

  // 8) Pooled minutes: member's call time draws down the OWNER's pool.
  const billingStore = require("../src/billing/store");
  await billingStore.bump(String(u2.id), "agent_min", 55); // member talked 55 min
  const left1 = (await billingStore.remaining(String(u1.id), "agent_min")).left;
  const left2 = (await billingStore.remaining(String(u2.id), "agent_min")).left;
  assert.strictEqual(left1, 5, "owner sees the pooled drawdown");
  assert.strictEqual(left2, 5, "member sees the same pool");
  console.log("✔ family agent minutes are pooled (60 − 55 = 5 for everyone)");

  // 9) Wrong invite code / joining own family are clean 400s.
  r = await api("POST", "/billing/family/join", { token: u1.token, body: { code } });
  assert.strictEqual(r.status, 400);
  r = await api("POST", "/billing/family/join", { token: u2.token, body: { code: "XXXXXX" } });
  assert.strictEqual(r.status, 400);
  console.log("✔ family joins validated");

  // 10) Admin stats: hidden without the key, counts with it.
  r = await api("GET", "/admin/stats");
  assert.strictEqual(r.status, 404);
  r = await api("GET", "/admin/stats", { headers: { "X-Admin-Key": "admin-key-16-chars-min" } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.users, 2);
  assert.ok(r.json.activeSubscriptions.family >= 1);
  console.log("✔ admin stats: 404 without key, real counts with it");

  console.log("\nBILLING TEST PASSED ✔");
  process.exit(0);
}

main().catch((e) => {
  console.error("BILLING TEST FAILED ✘\n", e);
  process.exit(1);
});
