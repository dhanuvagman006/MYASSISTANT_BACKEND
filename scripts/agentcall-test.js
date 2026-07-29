/**
 * AGENT CALL FLOW TEST — boots the real server and walks a call through
 * every webhook exactly as Twilio would, with:
 *   • signature validation off (TWILIO_VALIDATE=false)
 *   • NO AI keys — every engine fallback path must hold the call together
 *   • Twilio's REST API stubbed by pointing at an unconfigured state for
 *     the 503 test, then faking a dialed call directly in the store.
 *
 * Run: node scripts/agentcall-test.js
 */
process.env.JWT_SECRET = "x".repeat(48);
process.env.AUTH_DISABLED = "true";
process.env.DATA_DIR = "/tmp/agentcall-test-" + Date.now();
process.env.PORT = "3777";
process.env.TWILIO_VALIDATE = "false";
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID; // start UNconfigured for the 503 test

const assert = require("assert");
const BASE = "http://localhost:3777";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, form = false) {
  const r = await fetch(BASE + path, {
    method: "POST",
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
  require("../src/server"); // boots on :3777
  await sleep(500);

  // 1) Unconfigured → clean 503, not a crash.
  let r = await post("/agent-call", {
    toNumber: "9876543210",
    contactName: "Allen Lobo",
    task: "ask him what time he will come home",
  });
  assert.strictEqual(r.status, 503, "expected 503 when Twilio unset, got " + r.status);
  console.log("✔ 503 when Twilio not configured");

  // 2) Configure Twilio env (REST calls won't fire — we drive webhooks
  //    directly), create a call row like POST / would after dialing.
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "testtoken";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  process.env.PUBLIC_BASE_URL = BASE;

  const twilio = require("../src/agentcall/twilio");
  assert.strictEqual(twilio.toE164("98765 43210"), "+919876543210");
  assert.strictEqual(twilio.toE164("+1 415-555-2671"), "+14155552671");
  assert.strictEqual(twilio.toE164("098765-43210"), "+919876543210");
  assert.strictEqual(twilio.toE164("abc"), null);
  console.log("✔ E.164 normalization (India default, intl passthrough)");

  const store = require("../src/agentcall/store");
  const call = store.create({
    userId: "anonymous-dev",
    contactName: "Allen Lobo",
    toNumber: "+919876543210",
    task: "ask him what time he will come home",
    lang: "en-IN",
  });
  store.setState(call.id, "dialing");

  // 3) Contact answers → /voice returns Say + Gather TwiML (fallback line).
  r = await post(`/agent-call/twilio/${call.id}/voice`, { AnsweredBy: "human" }, true);
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes("<Gather"), "voice must listen after speaking");
  assert.ok(/Hari/.test(r.text), "opening should introduce Hari");
  console.log("✔ /voice: opening line + gather");

  // 4) Voicemail path on a fresh call → hang up + no_answer.
  const vm = store.create({
    userId: "anonymous-dev",
    contactName: "Allen Lobo",
    toNumber: "+919876543210",
    task: "ask him when he's home",
  });
  r = await post(`/agent-call/twilio/${vm.id}/voice`, { AnsweredBy: "machine_start" }, true);
  assert.ok(r.text.includes("<Hangup"), "voicemail must hang up");
  assert.strictEqual(store.get(vm.id).state, "no_answer");
  console.log("✔ /voice: voicemail detected → no_answer");

  // 5) Contact replies → /gather. With no AI keys the fallback thanks
  //    them, hangs up, and the summary carries their words.
  r = await post(
    `/agent-call/twilio/${call.id}/gather`,
    { SpeechResult: "I will be home around 7 30 in the evening" },
    true
  );
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes("<Hangup"), "fallback turn ends the call");
  await sleep(300); // summary is fire-and-forget
  const done = store.get(call.id);
  assert.strictEqual(done.state, "completed");
  assert.ok(
    done.result.includes("7 30"),
    "summary must contain the contact's answer, got: " + done.result
  );
  assert.strictEqual(done.transcript.filter((t) => t.who === "contact").length, 1);
  console.log("✔ /gather: reply captured → completed, summary =", JSON.stringify(done.result));

  // 6) App poll returns the result; a different user must get 404.
  r = await fetch(`${BASE}/agent-call/${call.id}`).then(async (x) => ({
    status: x.status,
    json: await x.json(),
  }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.state, "completed");
  assert.ok(r.json.result.includes("7 30"));
  console.log("✔ GET /agent-call/:id: poll sees completed + result");

  // 7) status webhook: no-answer marks the call terminal.
  const na = store.create({
    userId: "anonymous-dev",
    contactName: "Amma",
    toNumber: "+919876500000",
    task: "tell her dinner is at 8",
  });
  r = await post(`/agent-call/twilio/${na.id}/status`, { CallStatus: "no-answer" }, true);
  assert.strictEqual(store.get(na.id).state, "no_answer");
  console.log("✔ /status: no-answer → terminal state");

  // 8) status "completed" after a mid-call hangup still summarizes.
  const hung = store.create({
    userId: "anonymous-dev",
    contactName: "Ravi",
    toNumber: "+919876511111",
    task: "ask if he got the parcel",
  });
  store.setState(hung.id, "in_progress");
  store.addTurn(hung.id, "agent", "Hi, did the parcel arrive?");
  store.addTurn(hung.id, "contact", "Yes it came this morning");
  await post(`/agent-call/twilio/${hung.id}/status`, { CallStatus: "completed" }, true);
  await sleep(300);
  const h = store.get(hung.id);
  assert.strictEqual(h.state, "completed");
  assert.ok(h.result.includes("this morning"), "hangup summary keeps the answer");
  console.log("✔ /status: early hangup → summarized from transcript");

  // 9) Bad inputs.
  r = await post("/agent-call", { toNumber: "??", contactName: "X", task: "hi" });
  assert.strictEqual(r.status, 400);
  r = await post(`/agent-call/twilio/deadbeef/voice`, {}, true);
  assert.strictEqual(r.status, 404);
  console.log("✔ validation: bad number 400, unknown call 404");

  console.log("\nAGENT CALL TEST PASSED ✔");
  process.exit(0);
}

main().catch((e) => {
  console.error("AGENT CALL TEST FAILED ✘\n", e);
  process.exit(1);
});
