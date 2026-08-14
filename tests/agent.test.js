/**
 * Phase 1 tests — tool registry + agent runtime.
 * Run: node tests/agent.test.js
 *
 * The Gemini call is stubbed so the LOOP is tested deterministically:
 * tool selection, argument coercion, confirmation gating, device actions,
 * honest failure reporting, and loop termination.
 */
const assert = require("assert");
const path = require("path");
const Module = require("module");

process.env.GEMINI_API_KEY = "test-key";
// DB-backed tool modules refuse to load without this. No connection is made:
// these tests never call a DB-touching tool.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://t:t@127.0.0.1:5432/t";

const registry = require("../src/tools/registry");

let pass = 0,
  fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log("PASS  " + name);
    pass++;
  } catch (e) {
    console.log("FAIL  " + name + "\n      " + e.message);
    fail++;
  }
}
// Async tests share the stubbed model SCRIPT, so they MUST run one at a
// time — queue them and drain sequentially at the end.
const QUEUE = [];
function ta(name, fn) {
  QUEUE.push([name, fn]);
}
async function drain() {
  for (const [name, fn] of QUEUE) {
    try {
      await fn();
      console.log("PASS  " + name);
      pass++;
    } catch (e) {
      console.log("FAIL  " + name + "\n      " + e.message);
      fail++;
    }
  }
}

// ---------------- registry ----------------

registry._clear();
registry.register({
  name: "echo",
  description: "echo",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      count: { type: "integer" },
      flag: { type: "boolean" },
    },
    required: ["text"],
  },
  execute: async (a) => ({ ok: true, data: a }),
});
registry.register({
  name: "danger",
  description: "deletes things",
  risk: "high",
  inputSchema: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
  confirmSummary: (a) => `Delete ${a.what}`,
  execute: async () => ({ ok: true, data: "deleted" }),
});
registry.register({
  name: "call_device",
  description: "device action",
  risk: "high",
  deviceAction: true,
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  execute: async (a) => ({ ok: true, deviceAction: { type: "call", name: a.name } }),
});
registry.register({
  name: "broken",
  description: "always throws",
  risk: "low",
  inputSchema: { type: "object", properties: {} },
  execute: async () => {
    throw new Error("upstream exploded");
  },
});

t("duplicate registration rejected", () => {
  assert.throws(() => registry.register({ name: "echo", execute: () => {} }));
});
t("invalid risk rejected", () => {
  assert.throws(() =>
    registry.register({ name: "x", risk: "nuclear", execute: () => {} })
  );
});
t("declarations use uppercase types", () => {
  const d = registry.declarations().find((x) => x.name === "echo");
  assert.strictEqual(d.parameters.type, "OBJECT");
  assert.strictEqual(d.parameters.properties.text.type, "STRING");
  assert.strictEqual(d.parameters.properties.count.type, "INTEGER");
});
t("declarations can exclude device actions", () => {
  const names = registry
    .declarations({ includeDeviceActions: false })
    .map((d) => d.name);
  assert.ok(!names.includes("call_device"));
  assert.ok(names.includes("echo"));
});
t("args coerced to declared types", () => {
  const tool = registry.get("echo");
  const a = registry.coerceArgs(tool, { text: 42, count: "7", flag: "true", junk: 1 });
  assert.strictEqual(a.text, "42");
  assert.strictEqual(a.count, 7);
  assert.strictEqual(a.flag, true);
  assert.ok(!("junk" in a), "unknown keys dropped");
});

ta("missing required arg -> needsArgs, not a crash", async () => {
  const r = await registry.execute("echo", {}, {});
  assert.deepStrictEqual(r.needsArgs, ["text"]);
});
ta("high risk blocks without approval", async () => {
  const r = await registry.execute("danger", { what: "file" }, {});
  assert.strictEqual(r.needsConfirmation, true);
  assert.strictEqual(r.summary, "Delete file");
});
ta("high risk runs when approved", async () => {
  const r = await registry.execute("danger", { what: "file" }, { approved: true });
  assert.strictEqual(r.ok, true);
});
ta("thrown error becomes honest failure, never success", async () => {
  const r = await registry.execute("broken", {}, {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /upstream exploded/);
});
ta("unknown tool reported", async () => {
  const r = await registry.execute("nope", {}, {});
  assert.strictEqual(r.ok, false);
});

// ---------------- runtime (Gemini stubbed) ----------------

const routerPath = require.resolve("../src/services/ai/router");
const realRouter = require(routerPath);
let SCRIPT = [];
let seen = [];
require.cache[routerPath].exports = {
  ...realRouter,
  generateWithTools: async ({ contents, declarations }) => {
    seen.push({ contents: JSON.parse(JSON.stringify(contents)), declarations });
    return SCRIPT.shift() || { functionCalls: [], text: "(done)" };
  },
};

// runtime registers builtins on require; keep our test tools too.
const before = registry.list().map((x) => x.name);
const { runAgentTurn } = require("../src/agents/runtime");
t("builtins registered alongside test tools", () => {
  const names = registry.list().map((x) => x.name);
  assert.ok(names.includes("get_weather"), "weather tool registered");
  assert.ok(names.includes("place_phone_call"), "call tool registered");
  assert.ok(names.includes("web_search"), "search tool registered");
  before.forEach((n) => assert.ok(names.includes(n)));
});

ta("direct answer needs no tools", async () => {
  SCRIPT = [{ functionCalls: [], text: "Hello there." }];
  seen = [];
  const r = await runAgentTurn("hello", {});
  assert.strictEqual(r.text, "Hello there.");
  assert.strictEqual(r.toolResults.length, 0);
});

ta("tool call executes and result is fed back", async () => {
  SCRIPT = [
    { functionCalls: [{ name: "echo", args: { text: "hi" } }], text: "" },
    { functionCalls: [], text: "You said hi." },
  ];
  seen = [];
  const r = await runAgentTurn("say hi", {});
  assert.strictEqual(r.text, "You said hi.");
  assert.strictEqual(r.toolResults[0].name, "echo");
  const followUp = seen[1].contents;
  const fr = followUp[followUp.length - 1].parts[0].functionResponse;
  assert.strictEqual(fr.name, "echo");
  assert.strictEqual(fr.response.ok, true);
});

ta("failed tool is reported to the model as failed", async () => {
  SCRIPT = [
    { functionCalls: [{ name: "broken", args: {} }], text: "" },
    { functionCalls: [], text: "That failed, sorry." },
  ];
  seen = [];
  const r = await runAgentTurn("do it", {});
  const fr = seen[1].contents.slice(-1)[0].parts[0].functionResponse;
  assert.strictEqual(fr.response.ok, false);
  assert.match(fr.response.error, /exploded/);
  assert.strictEqual(r.toolResults[0].ok, false);
});

ta("high-risk tool halts the turn for confirmation", async () => {
  SCRIPT = [{ functionCalls: [{ name: "danger", args: { what: "notes" } }], text: "" }];
  const r = await runAgentTurn("delete notes", {});
  assert.ok(r.needsConfirmation);
  assert.strictEqual(r.needsConfirmation.summary, "Delete notes");
});

ta("approved device action returns an action, not a claim of success", async () => {
  SCRIPT = [
    { functionCalls: [{ name: "call_device", args: { name: "Mom" } }], text: "" },
    { functionCalls: [], text: "Calling Mom now." },
  ];
  const r = await runAgentTurn("call mom", { approved: true });
  assert.strictEqual(r.deviceActions.length, 1);
  assert.deepStrictEqual(r.deviceActions[0], { type: "call", name: "Mom" });
});

ta("tool loop terminates (no infinite rounds)", async () => {
  SCRIPT = Array(10).fill({
    functionCalls: [{ name: "echo", args: { text: "x" } }],
    text: "",
  });
  const r = await runAgentTurn("loop", {});
  assert.ok(r.toolResults.length <= 3, `bounded, got ${r.toolResults.length}`);
});

ta("history is trimmed, not sent wholesale", async () => {
  SCRIPT = [{ functionCalls: [], text: "ok" }];
  seen = [];
  const history = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `m${i}`,
  }));
  await runAgentTurn("now", { history });
  assert.ok(seen[0].contents.length <= 9, `got ${seen[0].contents.length}`);
});

ta("web_search is honest when unconfigured", async () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.GOOGLE_CSE_KEY;
  const r = await registry.execute("web_search", { query: "nvidia" }, {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not configured/);
});

drain().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
