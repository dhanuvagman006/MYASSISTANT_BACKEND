/**
 * AVATAR LIVE-BRAIN E2E — proves the re-architecture requirements at the
 * backend boundary, with the Gemini call stubbed (like agent.test.js) so
 * the loop is deterministic:
 *
 *   §2/§25  session identity comes from the profile, not a name prompt
 *   §3      per-user bearer key maps live utterances to the right user
 *   §5/§27  what the user says in "session 1" is known in "session 2"
 *   §11     the live turn runs the real tool registry (device actions)
 *   §14     high-risk tools halt for a SPOKEN confirmation, yes executes
 *   §19     the rolling recent-conversation window caps and persists
 *
 * Run: node tests/avatar.e2e.test.js   (needs Postgres at 55432)
 */
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-secret-at-least-32-characters-long!";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@127.0.0.1:55432/myassistant_test";
process.env.GEMINI_API_KEY = "test-key";
process.env.TAVUS_API_KEY = "test-tavus";
process.env.TAVUS_FACE_ID = "face-1";

const assert = require("assert");

/* ---- stub the model exactly like agent.test.js ------------------- */
const routerPath = require.resolve("../src/services/ai/router");
const realRouter = require(routerPath);
let modelScript = [];
require.cache[routerPath].exports = {
  ...realRouter,
  generateWithTools: async () =>
    modelScript.shift() || { functionCalls: [], text: "(done)" },
  // memory.extractAndStore uses generateReply; keep it inert here — the
  // durable-fact path is exercised via saveMemory directly below.
  generateReply: async () => ({ reply: "[]" }),
};

const db = require("../src/db");
const ctx = require("../src/users/context");
const memory = require("../src/agents/memory");
const convoState = require("../src/avatar/state");
const live = require("../src/avatar/llm");
const { buildSession } = require("../src/avatar/tavus");
const { run, one } = db;

let pass = 0, fail = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log("PASS  " + name);
    pass++;
  } catch (e) {
    console.log("FAIL  " + name + "\n      " + (e.stack || e.message));
    fail++;
  }
}

const UID = 9901;

(async () => {
  await db.init();

  // Clean slate for this user.
  for (const q of [
    `DELETE FROM avatar_personas WHERE user_id=$1`,
    `DELETE FROM avatar_sessions WHERE user_id=$1`,
    `DELETE FROM conversation_state WHERE user_id=$1`,
    `DELETE FROM user_instructions WHERE user_id=$1`,
    `DELETE FROM users WHERE id=$1`,
  ]) await run(q, [UID]).catch(() => {});
  await memory.deleteAllMemories(UID).catch(() => {});

  // Seed the authenticated account: this is the source of truth (§3).
  const cols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='users'`
  )).map((c) => c.column_name);
  const base = { id: UID, name: "Dhanush", gender: "male" };
  if (cols.includes("email")) base.email = "dhanush@test.local";
  if (cols.includes("created_at")) base.created_at = Date.now();
  const keys = Object.keys(base);
  await run(
    `INSERT INTO users (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})
     ON CONFLICT (id) DO UPDATE SET name='Dhanush', gender='male'`,
    Object.values(base)
  );
  await ctx.setAssistantProfile(UID, { name: "Maya" });
  await ctx.addInstruction(UID, "Always ask before sending messages");

  /* =========================== SESSION 1 =========================== */

  await t("§2 session identity comes from the profile, not a prompt", async () => {
    const s = await buildSession(UID, { localHour: 19 });
    assert.strictEqual(s.userName, "Dhanush");
    assert.strictEqual(s.assistantName, "Maya");
    assert.strictEqual(
      s.greeting,
      "Good evening, Dhanush. I'm Maya. How can I help you today?"
    );
  });

  await t("live turn answers through the unified agent", async () => {
    modelScript = [{ text: "Hello Dhanush!", functionCalls: [] }];
    const reply = await live.runLiveTurn(UID, [
      { role: "user", content: "hello" },
    ]);
    assert.strictEqual(reply, "Hello Dhanush!");
  });

  await t("user states a durable fact; recency window records it", async () => {
    modelScript = [{ text: "Got it — Ravi, property litigation in Mangalore.", functionCalls: [] }];
    const reply = await live.runLiveTurn(UID, [
      { role: "user", content: "Ravi is my client and his case is property litigation in Mangalore." },
    ]);
    assert.ok(reply.includes("Ravi"));
    const summary = await convoState.getSummary(UID);
    assert.ok(summary.includes("Ravi is my client"));
    assert.ok(summary.includes("property litigation"));
  });

  // Memory extraction is async best-effort with a model call we stubbed
  // OUT of gemini.generateReply — store the durable fact directly the way
  // the extractor would, so session 2 can prove retrieval end-to-end.
  await memory.saveMemory(UID, "Ravi is Dhanush's client; property litigation case in Mangalore", 3);

  /* ============ "Close the app" — simulate a fresh session ========== */
  // A new live session = a new room + a freshly built context (§6, §18).

  await t("§5/§27 SESSION 2: new session context knows about Ravi", async () => {
    const s2 = await buildSession(UID, { localHour: 9 });
    assert.ok(s2.context.includes("Ravi"), "memory made it into the new session");
    assert.ok(s2.context.includes("property litigation"));
    assert.ok(s2.context.includes("Ravi is my client"), "recent conversation carried over");
    assert.ok(s2.greeting.startsWith("Good morning, Dhanush"));
  });

  await t("§14 standing rules are in the new session context", async () => {
    const s2 = await buildSession(UID, {});
    assert.ok(s2.context.includes("Always ask before sending messages"));
  });

  await t("§11 live tool call: high-risk halts for spoken confirmation", async () => {
    modelScript = [
      { text: "", functionCalls: [{ name: "place_phone_call", args: { name: "Ravi" } }] },
    ];
    const reply = await live.runLiveTurn(UID, [
      { role: "user", content: "Call Ravi" },
    ]);
    assert.ok(/confirm/i.test(reply) && reply.includes("Call Ravi"),
      `should ask to confirm, got: ${reply}`);
    assert.ok(live._pendingConfirm.has(UID));
  });

  await t("§14 spoken 'yes' executes and queues the DEVICE action", async () => {
    const reply = await live.runLiveTurn(UID, [
      { role: "user", content: "yes" },
    ]);
    assert.ok(/calling ravi/i.test(reply), `got: ${reply}`);
    assert.ok(!live._pendingConfirm.has(UID));
    // The phone dials on the DEVICE (§11): action must be queued.
    let got = null;
    const fakeRes = { write: (s) => { if (s.startsWith("id:")) got = s; } };
    live.attachActionListener(UID, fakeRes);
    live.detachActionListener(UID, fakeRes);
    assert.ok(got && got.includes("resolve_and_call") && got.includes("Ravi"));
  });

  await t("§14 spoken 'no' cancels a pending action", async () => {
    modelScript = [
      { text: "", functionCalls: [{ name: "place_phone_call", args: { name: "Mom" } }] },
    ];
    await live.runLiveTurn(UID, [{ role: "user", content: "call mom" }]);
    const reply = await live.runLiveTurn(UID, [{ role: "user", content: "no, leave it" }]);
    assert.strictEqual(reply, "Okay, I won't.");
    assert.ok(!live._pendingConfirm.has(UID));
  });

  await t("§19 rolling window is hard-capped", async () => {
    for (let i = 0; i < 40; i++) {
      await convoState.appendTurn(UID, "x".repeat(200), "y".repeat(200));
    }
    const s = await convoState.getSummary(UID);
    assert.ok(s.length <= convoState.MAX_CHARS, `len=${s.length}`);
  });

  await t("§3 unknown bearer key maps to no user", async () => {
    const row = await one(
      `SELECT user_id FROM avatar_personas WHERE api_key=$1`,
      ["not-a-real-key-000000000000000000"]
    );
    assert.ok(row == null);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("SETUP FAILED:", e.message);
  process.exit(1);
});
