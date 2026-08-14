/**
 * MCP END-TO-END TESTS (§19 A–H).
 *
 * Real PostgreSQL + a REAL MCP server (tests/fixtures/mcp-test-server.js)
 * spoken to over genuine stdio JSON-RPC via the official SDK. Only the LLM
 * is stubbed, so tool SELECTION is deterministic while discovery,
 * permission, execution, isolation and failure handling are all real.
 */
const assert = require("assert");
const path = require("path");

process.env.GEMINI_API_KEY = "test-key";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-at-least-32-characters-long!";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:55432/myassistant_test";

const db = require("../src/db");
const registry = require("../src/tools/registry");
const manager = require("../src/mcp/manager");
const mcpSchema = require("../src/mcp/schema");

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

// Stub only the model.
const routerPath = require.resolve("../src/services/ai/router");
const realRouter = require(routerPath);
let SCRIPT = [];
let LAST_DECLS = [];
require.cache[routerPath].exports = {
  ...realRouter,
  generateWithTools: async ({ declarations }) => {
    LAST_DECLS = declarations;
    return SCRIPT.shift() || { functionCalls: [], text: "(done)" };
  },
};
const { runAgentTurn } = require("../src/agents/runtime");

const SERVER_PATH = path.join(__dirname, "fixtures", "mcp-test-server.js");
let USER_A, USER_B, ROW_A, ROW_B;

async function setup() {
  await db.init();
  await db.run(`DELETE FROM mcp_servers`);
  await db.run(`DELETE FROM users WHERE email LIKE 'mcp-%'`);
  const t = Date.now();
  USER_A = (await db.one(`INSERT INTO users (email,name,created_at) VALUES ('mcp-a@test','A',$1) RETURNING id`, [t])).id;
  USER_B = (await db.one(`INSERT INTO users (email,name,created_at) VALUES ('mcp-b@test','B',$1) RETURNING id`, [t])).id;
}

/* ---------------- A: add + ownership ---------------- */

test("A: an MCP server is stored against the creating user, with secrets encrypted", async () => {
  const { config, secrets } = mcpSchema.splitSecrets({
    config: { command: process.execPath, args: [SERVER_PATH], token: "super-secret-token" },
  });
  assert.ok(!("token" in config), "secret-shaped config moved out of plaintext config");
  assert.strictEqual(secrets.token, "super-secret-token");

  ROW_A = await db.one(
    `INSERT INTO mcp_servers (user_id,name,description,transport,config,secrets_enc,enabled,status,created_at,updated_at)
     VALUES ($1,'GitHub','test','stdio',$2,$3,1,'disconnected',$4,$4) RETURNING *`,
    [USER_A, JSON.stringify(config), mcpSchema.encryptSecrets(secrets), Date.now()]
  );
  assert.strictEqual(Number(ROW_A.user_id), USER_A);
  assert.ok(ROW_A.secrets_enc && !ROW_A.secrets_enc.includes("super-secret-token"), "stored ciphertext");
  assert.deepStrictEqual(mcpSchema.decryptSecrets(ROW_A.secrets_enc), { token: "super-secret-token" });
});

test("A: the client serialiser never emits secrets (§13)", async () => {
  const json = JSON.stringify(mcpSchema.toClient(ROW_A));
  assert.ok(!json.includes("super-secret-token"), "no secret in payload");
  assert.ok(!json.includes("secrets_enc"), "no ciphertext in payload");
  assert.strictEqual(mcpSchema.toClient(ROW_A).hasSecrets, true);
});

/* ---------------- B: connect + discovery ---------------- */

test("B: connecting discovers tools over real MCP stdio", async () => {
  const out = await manager.connect(USER_A, ROW_A, mcpSchema.decryptSecrets(ROW_A.secrets_enc));
  assert.strictEqual(out.ok, true, "connected: " + (out.error || ""));
  assert.strictEqual(out.status, "connected");
  const names = out.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ["always_fails", "create_issue", "delete_repository", "search_repositories"]);
});

/* ---------------- C: unified registry ---------------- */

test("C: discovered tools appear in the SAME registry as built-ins", async () => {
  const all = registry.list().map((t) => t.name);
  assert.ok(all.includes("get_weather"), "built-in still present");
  assert.ok(all.includes(manager.toolName(USER_A, "GitHub", "search_repositories")), "MCP tool registered");
  const tool = registry.get(manager.toolName(USER_A, "GitHub", "search_repositories"));
  assert.strictEqual(tool.source, "mcp");
  assert.ok(tool.description.includes("[GitHub]"), "server-labelled description for the model");
});

test("C: risk is classified from capability, not trusted blindly (§9)", async () => {
  const r = (t) => registry.get(manager.toolName(USER_A, "GitHub", t)).risk;
  assert.strictEqual(r("search_repositories"), "low");
  assert.strictEqual(r("create_issue"), "medium");
  assert.strictEqual(r("delete_repository"), "high");
});

/* ---------------- D: agent execution ---------------- */

test("D: the agent selects and executes an MCP tool end-to-end", async () => {
  const toolN = manager.toolName(USER_A, "GitHub", "search_repositories");
  SCRIPT = [
    { functionCalls: [{ name: toolN, args: { q: "ravi" } }], text: "" },
    { functionCalls: [], text: "I found two repositories." },
  ];
  const r = await runAgentTurn("search my repos for ravi", { userId: USER_A });
  assert.strictEqual(r.text, "I found two repositories.");
  assert.strictEqual(r.toolResults[0].ok, true);
  assert.match(String(r.toolResults[0].speak), /ravi-notes/);
});

test("D: an MCP tool error is reported honestly, not as success (§10)", async () => {
  const res = await registry.execute(
    manager.toolName(USER_A, "GitHub", "always_fails"), {}, { userId: USER_A }
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /500/);
});

/* ---------------- E: permissions ---------------- */

test("E: a high-risk MCP tool requires confirmation, like any built-in", async () => {
  const res = await registry.execute(
    manager.toolName(USER_A, "GitHub", "delete_repository"),
    { repo: "x" },
    { userId: USER_A }
  );
  assert.strictEqual(res.needsConfirmation, true);
});

test("E: it runs once approved", async () => {
  const res = await registry.execute(
    manager.toolName(USER_A, "GitHub", "delete_repository"),
    { repo: "x" },
    { userId: USER_A, approved: true }
  );
  assert.strictEqual(res.ok, true);
});

/* ---------------- F: isolation ---------------- */

test("F: user B never SEES user A's MCP tools in declarations", async () => {
  SCRIPT = [{ functionCalls: [], text: "hi" }];
  await runAgentTurn("hello", { userId: USER_B });
  const names = LAST_DECLS.map((d) => d.name);
  assert.ok(names.includes("get_weather"), "built-ins offered to B");
  assert.ok(!names.some((n) => n.startsWith("mcp_")), "no MCP tools offered to B");
});

test("F: user A DOES see their own MCP tools", async () => {
  SCRIPT = [{ functionCalls: [], text: "hi" }];
  await runAgentTurn("hello", { userId: USER_A });
  const names = LAST_DECLS.map((d) => d.name);
  assert.ok(names.includes(manager.toolName(USER_A, "GitHub", "search_repositories")));
});

test("F: user B cannot execute A's MCP tool even knowing its exact name", async () => {
  const res = await registry.execute(
    manager.toolName(USER_A, "GitHub", "search_repositories"),
    { q: "ravi" },
    { userId: USER_B }
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /unknown tool/);
});

/* ---------------- G: failure resilience ---------------- */

test("G: a broken MCP server does not break the agent", async () => {
  const bad = await db.one(
    `INSERT INTO mcp_servers (user_id,name,transport,config,enabled,status,created_at,updated_at)
     VALUES ($1,'Broken','stdio',$2,1,'disconnected',$3,$3) RETURNING *`,
    [USER_A, JSON.stringify({ command: process.execPath, args: ["/nonexistent/server.js"] }), Date.now()]
  );
  const out = await manager.connect(USER_A, bad, {});
  assert.strictEqual(out.ok, false, "connection failed as expected");
  assert.strictEqual(out.status, "error");
  assert.ok(out.error, "error recorded for the settings badge");

  // The agent keeps working on built-ins.
  SCRIPT = [{ functionCalls: [], text: "still here" }];
  const r = await runAgentTurn("are you ok", { userId: USER_A });
  assert.strictEqual(r.text, "still here");
  const names = registry.list().map((t) => t.name);
  assert.ok(names.includes("get_weather"), "built-ins intact");
  assert.ok(names.includes(manager.toolName(USER_A, "GitHub", "search_repositories")), "healthy server unaffected");
});

/* ---------------- H: disconnect ---------------- */

test("H: disconnecting withdraws that server's tools from the registry", async () => {
  await manager.disconnect(USER_A, ROW_A.id);
  const names = registry.list().map((t) => t.name);
  assert.ok(!names.some((n) => n.startsWith(`mcp_${USER_A}_github_`)), "MCP tools withdrawn");
  assert.ok(names.includes("get_weather"), "built-ins untouched");
});

test("H: a withdrawn tool can no longer be executed", async () => {
  const res = await registry.execute(
    manager.toolName(USER_A, "GitHub", "search_repositories"), { q: "x" }, { userId: USER_A }
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /unknown tool/);
});

test("H: reconnecting restores them (no duplicate-registration crash)", async () => {
  const out = await manager.connect(USER_A, ROW_A, mcpSchema.decryptSecrets(ROW_A.secrets_enc));
  assert.strictEqual(out.ok, true);
  const out2 = await manager.connect(USER_A, ROW_A, mcpSchema.decryptSecrets(ROW_A.secrets_enc));
  assert.strictEqual(out2.ok, true, "second connect is idempotent");
  await manager.disconnect(USER_A, ROW_A.id);
});

setup()
  .then(drain)
  .then(async () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    await db.close();
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    console.error("SETUP FAILED:", e.stack || e.message);
    process.exit(1);
  });
