/**
 * USER CONTEXT TESTS (§3, §4, §13, §14) — real PostgreSQL.
 * Extraction's model call is stubbed with a scripted structured response;
 * everything below it (persistence, merging, rules, context assembly,
 * isolation) is real.
 */
const assert = require("assert");

process.env.GEMINI_API_KEY = "test-key";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-at-least-32-characters-long!";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:55432/myassistant_test";

const db = require("../src/db");

let pass = 0, fail = 0;
const QUEUE = [];
const test = (n, f) => QUEUE.push([n, f]);
async function drain() {
  for (const [n, f] of QUEUE) {
    try { await f(); console.log("PASS  " + n); pass++; }
    catch (e) { console.log("FAIL  " + n + "\n      " + (e.stack || e.message).split("\n").slice(0, 3).join("\n      ")); fail++; }
  }
}

// Stub the model for extraction + agent turns.
const routerPath = require.resolve("../src/services/ai/router");
const real = require(routerPath);
let EXTRACT = "{}";
let LAST_SYSTEM = "";
require.cache[routerPath].exports = {
  ...real,
  callGemini: async () => EXTRACT,
  generateWithTools: async ({ system }) => {
    LAST_SYSTEM = system;
    return { functionCalls: [], text: "ok" };
  },
};
const ctx = require("../src/users/context");
const { runAgentTurn } = require("../src/agents/runtime");
const registry = require("../src/tools/registry");
require("../src/tools/builtins").registerBuiltins();

let A, B;
async function setup() {
  await db.init();
  await db.run(`DELETE FROM user_instructions`);
  await db.run(`DELETE FROM assistant_profiles`);
  await db.run(`DELETE FROM users WHERE email LIKE 'uc-%'`);
  const t = Date.now();
  A = (await db.one(`INSERT INTO users (email,name,gender,created_at) VALUES ('uc-a@test','Dhanush A','male',$1) RETURNING id`, [t])).id;
  B = (await db.one(`INSERT INTO users (email,name,created_at) VALUES ('uc-b@test','B',$1) RETURNING id`, [t])).id;
}

/* ---- conversational onboarding (§3) ---- */

test("free-form introduction is extracted into structured profile fields", async () => {
  EXTRACT = JSON.stringify({
    name: "Dhanush", gender: "", profession: "software engineer",
    organisation: "", location: "Mangalore", preferred_language: "English", timezone: "",
  });
  const out = await ctx.extractProfile(A, "I'm Dhanush, I live in Mangalore, I'm a software engineer.");
  assert.strictEqual(out.applied.profession, "software engineer");
  assert.strictEqual(out.applied.location, "Mangalore");
  const p = await ctx.getProfile(A);
  assert.strictEqual(p.user.profession, "software engineer");
  assert.strictEqual(p.user.location, "Mangalore");
});

test("extraction only fills fields; empty extractions never blank stored data", async () => {
  EXTRACT = JSON.stringify({ name: "", profession: "", location: "" });
  await ctx.extractProfile(A, "nothing useful here");
  const p = await ctx.getProfile(A);
  assert.strictEqual(p.user.profession, "software engineer", "existing data preserved");
});

test("a broken extraction reports honestly instead of failing onboarding", async () => {
  EXTRACT = "this is not json";
  const out = await ctx.extractProfile(A, "hello");
  assert.deepStrictEqual(out.applied, {});
  assert.match(out.error, /form/);
});

/* ---- assistant identity (§4) ---- */

test("assistant can be renamed (Maya) and styled; partial updates merge", async () => {
  await ctx.setAssistantProfile(A, { name: "Maya", style: "concise" });
  await ctx.setAssistantProfile(A, { voice: "Aoede" }); // must not reset name
  const p = await ctx.getProfile(A);
  assert.strictEqual(p.assistant.name, "Maya");
  assert.strictEqual(p.assistant.style, "concise");
  assert.strictEqual(p.assistant.voice, "Aoede");
});

/* ---- standing rules (§14) ---- */

test("standing rules persist and de-duplicate", async () => {
  await ctx.addInstruction(A, "Always ask me before sending messages.");
  await ctx.addInstruction(A, "always ask me before sending messages.");
  await ctx.addInstruction(A, "Call me Dhanu.");
  const rules = await ctx.listInstructions(A);
  assert.strictEqual(rules.length, 2, "case-insensitive duplicate collapsed");
});

test("removing a rule is a soft delete (audit preserved, §19)", async () => {
  const n = await ctx.removeInstruction(A, "sending messages");
  assert.strictEqual(n, 1);
  const rules = await ctx.listInstructions(A);
  assert.strictEqual(rules.length, 1);
  const row = await db.one(
    `SELECT active, deactivated_at FROM user_instructions
      WHERE user_id=$1 AND instruction ILIKE '%sending%'`, [A]);
  assert.strictEqual(row.active, 0);
  assert.ok(row.deactivated_at, "audit timestamp kept");
});

/* ---- context reaches the agent (§13) ---- */

test("profile, assistant identity and rules are injected into every turn", async () => {
  LAST_SYSTEM = "";
  await runAgentTurn("hello", { userId: A });
  assert.match(LAST_SYSTEM, /Dhanush/, "user identity present");
  assert.match(LAST_SYSTEM, /Mangalore/, "profile facts present");
  assert.match(LAST_SYSTEM, /your name is Maya/i, "assistant identity present");
  assert.match(LAST_SYSTEM, /Call me Dhanu/i, "standing rule present");
  assert.ok(!/sending messages/i.test(LAST_SYSTEM), "removed rule NOT present");
});

test("anonymous sessions get no injected context", async () => {
  LAST_SYSTEM = "";
  await runAgentTurn("hello", {});
  assert.ok(!/Mangalore|Maya/.test(LAST_SYSTEM));
});

/* ---- tools drive the same paths ---- */

test("configure_assistant tool renames the assistant", async () => {
  const r = await registry.execute("configure_assistant", { name: "Asha" }, { userId: A });
  assert.strictEqual(r.ok, true);
  assert.match(r.speak, /Asha/);
  const p = await ctx.getProfile(A);
  assert.strictEqual(p.assistant.name, "Asha");
});

test("add/remove standing-instruction tools work end-to-end", async () => {
  await registry.execute("add_standing_instruction",
    { instruction: "Never call anyone after 10pm." }, { userId: A });
  let rules = await ctx.listInstructions(A);
  assert.ok(rules.some((r) => /10pm/.test(r.instruction)));
  const rm = await registry.execute("remove_standing_instruction",
    { about: "after 10pm" }, { userId: A });
  assert.strictEqual(rm.ok, true);
  rules = await ctx.listInstructions(A);
  assert.ok(!rules.some((r) => /10pm/.test(r.instruction)));
});

/* ---- isolation (§32) ---- */

test("user B sees none of A's profile, rules or assistant identity", async () => {
  const p = await ctx.getProfile(B);
  assert.notStrictEqual(p.user.profession, "software engineer");
  assert.strictEqual(p.assistant.name, "Hari", "default, not A's Asha");
  assert.strictEqual((await ctx.listInstructions(B)).length, 0);
  LAST_SYSTEM = "";
  await runAgentTurn("hello", { userId: B });
  assert.ok(!/Mangalore|Asha|Dhanu/.test(LAST_SYSTEM));
});

test("missing userId is a hard failure, never a global read", async () => {
  await assert.rejects(() => ctx.getProfile(null), /authenticated userId required/);
  await assert.rejects(() => ctx.addInstruction(0, "x"), /authenticated userId required/);
});

setup().then(drain).then(async () => {
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.close();
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error("SETUP FAILED:", e.stack || e.message); process.exit(1); });
