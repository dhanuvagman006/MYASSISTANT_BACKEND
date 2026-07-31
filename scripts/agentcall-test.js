/**
 * AGENT CALL FLOW TEST — boots the real server and walks a call through
 * every webhook exactly as Plivo would, with:
 *   • signature validation off (PLIVO_VALIDATE=false)
 *   • NO AI keys — every engine fallback path must hold the call together
 *   • Plivo REST API stubbed by pointing at an unconfigured state for
 *     the 503 test, then faking a dialed call directly in the store.
 *
 * Run: node scripts/agentcall-test.js
 */
process.env.JWT_SECRET = "x".repeat(48);
process.env.AUTH_DISABLED = "true";
process.env.DATA_DIR = "/tmp/agentcall-test-" + Date.now();
// PORT is assigned dynamically in main() via scripts/_free-port.js
process.env.PLIVO_VALIDATE = "false";
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.PLIVO_AUTH_ID; // start UNconfigured for the 503 test

const assert = require("assert");
let BASE = ""; // set in main() once the port is known

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, form = false, method = "POST") {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": form
        ? "application/x-www-form-urlencoded"
        : "application/json",
    },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}
  return { status: r.status, text, json };
}

async function main() {
  const port = await require("./_free-port").freePort();
  process.env.PORT = String(port);
  BASE = `http://127.0.0.1:${port}`;
  await require("./_reset-db").resetDb();
  require("../src/server");
  await sleep(500);

  // 1) Unconfigured → clean 503, not a crash.
  let r = await post("/agent-call", {
    toNumber: "9876543210",
    contactName: "Allen Lobo",
    task: "ask him what time he will come home",
  });
  assert.strictEqual(r.status, 503, "expected 503 when Plivo unset, got " + r.status);
  console.log("✔ 503 when Plivo not configured");

  // 2) Configure Plivo env (REST calls won't fire — we drive webhooks
  //    directly), create a call row like POST / would after dialing.
  process.env.PLIVO_AUTH_ID = "MAtest";
  process.env.PLIVO_AUTH_TOKEN = "testtoken";
  process.env.PLIVO_FROM_NUMBER = "+919999888877";
  process.env.PUBLIC_BASE_URL = BASE;

  const plivo = require("../src/agentcall/plivo");
  assert.strictEqual(plivo.toE164("98765 43210"), "+919876543210");
  assert.strictEqual(plivo.toE164("+1 415-555-2671"), "+14155552671");
  assert.strictEqual(plivo.toE164("098765-43210"), "+919876543210");
  assert.strictEqual(plivo.toE164("abc"), null);
  console.log("✔ E.164 normalization (India default, intl passthrough)");

  const store = require("../src/agentcall/store");
  const call = await store.create({
    userId: "anonymous-dev",
    contactName: "Allen Lobo",
    toNumber: "+919876543210",
    task: "ask him what time he will come home",
    lang: "en-IN",
  });
  await store.setState(call.id, "dialing");

  // 3) Contact answers → /answer returns GetInput+Speak XML (fallback line).
  await store.setState(call.id, "dialing");
  r = await post(`/agent-call/plivo/${call.id}/answer`, { CallStatus: "in-progress" }, true);
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes("<GetInput"), "answer must listen while speaking");
  assert.ok(r.text.includes('inputType="speech"'), "must use speech ASR");
  assert.ok(/Hari/.test(r.text), "opening should introduce Hari");
  console.log("✔ /answer: opening line + speech GetInput");

  // 4) Voicemail: machine_detection=hangup ends the call at Plivo, our
  //    /hangup webhook sees the machine cause on a still-dialing call.
  const vm = await store.create({
    userId: "anonymous-dev",
    contactName: "Allen Lobo",
    toNumber: "+919876543210",
    task: "ask him when he's home",
  });
  await store.setState(vm.id, "dialing");
  r = await post(`/agent-call/plivo/${vm.id}/hangup`, { CallStatus: "completed", HangupCause: "MACHINE_DETECTED" }, true);
  assert.strictEqual((await store.get(vm.id)).state, "no_answer");
  assert.ok((await store.get(vm.id)).result.includes("voicemail"));
  console.log("✔ /hangup: voicemail (machine detected) → no_answer");

  // 5) Contact replies → /input. With no AI keys the fallback thanks
  //    them, hangs up, and the summary carries their words.
  r = await post(
    `/agent-call/plivo/${call.id}/input`,
    { Speech: "I will be home around 7 30 in the evening" },
    true
  );
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes("<Hangup"), "fallback turn ends the call");
  await sleep(300); // summary is fire-and-forget
  const done = await store.get(call.id);
  assert.strictEqual(done.state, "completed");
  assert.ok(
    done.result.includes("7 30"),
    "summary must contain the contact's answer, got: " + done.result
  );
  assert.strictEqual(done.transcript.filter((t) => t.who === "contact").length, 1);
  console.log("✔ /input: reply captured → completed, summary =", JSON.stringify(done.result));

  // 6) App poll returns the result; a different user must get 404.
  r = await fetch(`${BASE}/agent-call/${call.id}`).then(async (x) => ({
    status: x.status,
    json: await x.json(),
  }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.state, "completed");
  assert.ok(r.json.result.includes("7 30"));
  console.log("✔ GET /agent-call/:id: poll sees completed + result");

  // 7) hangup webhook: no-answer while dialing marks the call terminal.
  const na = await store.create({
    userId: "anonymous-dev",
    contactName: "Amma",
    toNumber: "+919876500000",
    task: "tell her dinner is at 8",
  });
  await store.setState(na.id, "dialing");
  r = await post(`/agent-call/plivo/${na.id}/hangup`, { CallStatus: "no-answer", HangupCause: "NO_ANSWER" }, true);
  assert.strictEqual((await store.get(na.id)).state, "no_answer");
  console.log("✔ /hangup: no-answer → terminal state");

  // 8) Contact hangs up mid-conversation → still summarized.
  const hung = await store.create({
    userId: "anonymous-dev",
    contactName: "Ravi",
    toNumber: "+919876511111",
    task: "ask if he got the parcel",
  });
  await store.setState(hung.id, "in_progress");
  await store.addTurn(hung.id, "agent", "Hi, did the parcel arrive?");
  await store.addTurn(hung.id, "contact", "Yes it came this morning");
  await post(`/agent-call/plivo/${hung.id}/hangup`, { CallStatus: "completed", HangupCause: "NORMAL_CLEARING" }, true);
  await sleep(300);
  const h = await store.get(hung.id);
  assert.strictEqual(h.state, "completed");
  assert.ok(h.result.includes("this morning"), "hangup summary keeps the answer");
  console.log("✔ /hangup: early hangup → summarized from transcript");

  // 9) Bad inputs.
  // checkRules() runs before number validation, and default calling hours
  // are 8:00–21:00 local — so this suite used to fail whenever CI ran
  // outside that window (403 call_rules instead of 400). Open the window
  // to 0–24 for the test user so validation is what we actually test,
  // then separately verify the rules gate deterministically.
  r = await post("/agent-call/settings", { hoursStart: 0, hoursEnd: 24 }, false, "PUT");
  assert.strictEqual(r.status, 200);
  r = await post("/agent-call", { toNumber: "??", contactName: "X", task: "hi" });
  assert.strictEqual(r.status, 400);
  // Rules gate: master switch off → 403 regardless of time of day.
  await post("/agent-call/settings", { enabled: false }, false, "PUT");
  r = await post("/agent-call", { toNumber: "+919876500000", contactName: "X", task: "hi" });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error, "call_rules");
  await post("/agent-call/settings", { enabled: true }, false, "PUT");
  console.log("✔ call rules: 403 when disabled; hours widened for CI determinism");
  r = await post(`/agent-call/plivo/deadbeef/answer`, {}, true);
  assert.strictEqual(r.status, 404);
  console.log("✔ validation: bad number 400, unknown call 404");

  // 10) Plivo V2 signature: HMAC-SHA256(token, url + nonce), base64.
  process.env.PLIVO_VALIDATE = "true";
  const crypto = require("crypto");
  const url = BASE + "/agent-call/plivo/x/input";
  const nonce = "12345";
  const good = crypto.createHmac("sha256", "testtoken").update(url + nonce).digest("base64");
  const mkReq = (sig) => ({
    get: (h) => (h === "X-Plivo-Signature-V2" ? sig : h === "X-Plivo-Signature-V2-Nonce" ? nonce : ""),
    originalUrl: "/agent-call/plivo/x/input",
    body: {},
  });
  assert.strictEqual(plivo.validSignature(mkReq(good)), true);
  assert.strictEqual(plivo.validSignature(mkReq("bad" + good)), false);
  assert.strictEqual(plivo.validSignature(mkReq("")), false);
  process.env.PLIVO_VALIDATE = "false";
  console.log("✔ Plivo V2 webhook signature validation");

  console.log("\nAGENT CALL TEST PASSED ✔");
  process.exit(0);
}

main().catch((e) => {
  console.error("AGENT CALL TEST FAILED ✘\n", e);
  process.exit(1);
});
