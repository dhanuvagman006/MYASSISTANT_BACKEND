/**
 * MCP MANAGER — external capabilities, same agent.
 *
 * §1/§20: there is NO MCP agent. Discovered MCP tools are normalised into
 * the existing tool registry with a namespaced name, so the runtime keeps
 * one selection path and one permission path. Nothing in agents/runtime.js
 * knows MCP exists.
 *
 * Protocol handling is the official @modelcontextprotocol/sdk — we do not
 * implement the wire protocol ourselves (§4).
 *
 * Isolation (§6): tools are registered per USER as `mcp.<user>.<server>.<tool>`
 * and the runtime only ever receives declarations for the calling user, so
 * user B cannot see — let alone call — user A's servers.
 *
 * Resilience (§11): a server that is slow, broken, unauthenticated or gone
 * is recorded as `error` and its tools are withdrawn. The agent keeps
 * working on built-ins; one bad server never takes the assistant down.
 */
const registry = require("../tools/registry");

const CONNECT_TIMEOUT_MS = Number(process.env.MCP_CONNECT_TIMEOUT_MS) || 12_000;
const CALL_TIMEOUT_MS = Number(process.env.MCP_CALL_TIMEOUT_MS) || 30_000;

/** live sessions: key `${userId}:${serverId}` -> {client, status, tools…} */
const SESSIONS = new Map();
const key = (userId, serverId) => `${Number(userId)}:${Number(serverId)}`;

/* ------------------------------------------------------------------ */
/* Risk classification (§9)                                            */
/* ------------------------------------------------------------------ */

/**
 * MCP servers are third-party: we cannot trust a tool to be safe because
 * it says so. Classify from the tool's own name/description and from any
 * annotations the server provides, defaulting to CAUTION rather than
 * convenience.
 */
const HIGH_RISK = /\b(delete|remove|destroy|drop|purge|wipe|erase|revoke|terminate|send|email|post|publish|transfer|pay|payment|charge|refund|merge|force[- ]?push|deploy|shutdown|restart|rotate|grant|invite)\b/i;
const MEDIUM_RISK = /\b(create|add|update|edit|modify|write|upload|rename|move|comment|assign|close|reopen|set|put|patch)\b/i;

function classifyRisk(tool) {
  const a = tool.annotations || {};
  // Trust an explicit read-only annotation; never trust a claim of safety
  // on something whose name says it destroys data.
  const text = `${tool.name} ${tool.description || ""}`;
  if (HIGH_RISK.test(text)) return "high";
  if (a.destructiveHint === true) return "high";
  if (a.readOnlyHint === true) return "low";
  if (MEDIUM_RISK.test(text)) return "medium";
  return "low";
}

/* ------------------------------------------------------------------ */
/* Naming (§8)                                                         */
/* ------------------------------------------------------------------ */

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "server";

/**
 * Registry name. Includes the user id so two users' identically-named
 * servers cannot collide, and so declarations can be filtered per user.
 * Gemini requires ^[a-zA-Z0-9_-]+$, hence underscores rather than dots.
 */
function toolName(userId, serverName, tool) {
  return `mcp_${Number(userId)}_${slug(serverName)}_${slug(tool)}`;
}

/** Model-facing name (no user id — the model shouldn't see tenant ids). */
function displayName(serverName, tool) {
  return `mcp.${slug(serverName)}.${slug(tool)}`;
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

async function buildTransport(row, secrets) {
  const cfg = row.config || {};
  const transport = String(row.transport || "http").toLowerCase();

  if (transport === "stdio") {
    const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
    if (!cfg.command) throw new Error("stdio transport needs config.command");
    return new StdioClientTransport({
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: { ...process.env, ...(secrets.env || {}), ...(cfg.env || {}) },
    });
  }

  const url = cfg.url;
  if (!url) throw new Error(`${transport} transport needs config.url`);
  // Secret headers were stored encrypted and are re-attached only here.
  const headers = { ...(cfg.headers || {}), ...(secrets.headers || {}) };
  if (secrets.token && !headers.Authorization) {
    headers.Authorization = `Bearer ${secrets.token}`;
  }

  if (transport === "sse") {
    const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
    return new SSEClientTransport(new URL(url), {
      requestInit: { headers },
      eventSourceInit: { headers },
    });
  }
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function statusOf(userId, serverId) {
  const s = SESSIONS.get(key(userId, serverId));
  return s ? { status: s.status, lastError: s.lastError } : null;
}

/**
 * Connects, discovers tools and registers them. Never throws: returns
 * {ok,status,tools,error} so one bad server degrades to an error badge in
 * settings instead of a failed request (§11).
 */
async function connect(userId, row, secrets) {
  const k = key(userId, row.id);
  await disconnect(userId, row.id); // idempotent reconnect

  const session = { status: "connecting", lastError: "", tools: [], serverName: row.name };
  SESSIONS.set(k, session);

  try {
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    const transport = await buildTransport(row, secrets || {});
    const client = new Client(
      { name: "myassistant", version: "1.0.0" },
      { capabilities: {} }
    );

    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connect timed out");
    session.client = client;

    const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, "tool discovery timed out");
    const tools = (listed?.tools || []).filter((t) => t && typeof t.name === "string");

    const registered = [];
    for (const t of tools) {
      const risk = classifyRisk(t);
      const name = toolName(userId, row.name, t.name);
      // Re-registering after a reconnect must not throw on duplicates.
      if (registry.get(name)) registry.unregister(name);
      registry.register({
        name,
        displayName: displayName(row.name, t.name),
        description: `[${row.name}] ${t.description || t.name}`,
        inputSchema: t.inputSchema || { type: "object", properties: {} },
        risk,
        source: "mcp",
        userId: Number(userId),
        serverId: Number(row.id),
        confirmSummary: () => `${displayName(row.name, t.name)} on ${row.name}`,
        execute: (args, ctx) => callTool(ctx.userId ?? userId, row.id, t.name, args),
      });
      registered.push({ name: t.name, description: t.description || "", risk });
    }

    session.status = "connected";
    session.tools = registered;
    session.registeredNames = registered.map((r) => toolName(userId, row.name, r.name));
    return { ok: true, status: "connected", tools: registered };
  } catch (e) {
    session.status = "error";
    session.lastError = String(e?.message || e).slice(0, 300);
    await withdrawTools(userId, row.id);
    return { ok: false, status: "error", tools: [], error: session.lastError };
  }
}

async function disconnect(userId, serverId) {
  const k = key(userId, serverId);
  const s = SESSIONS.get(k);
  await withdrawTools(userId, serverId);
  if (s?.client) {
    try {
      await s.client.close();
    } catch (_) {}
  }
  SESSIONS.delete(k);
  return { ok: true, status: "disconnected" };
}

/** Removes this server's tools from the unified registry (§H). */
async function withdrawTools(userId, serverId) {
  for (const t of registry.list()) {
    if (t.source === "mcp" && t.userId === Number(userId) && t.serverId === Number(serverId)) {
      registry.unregister(t.name);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Execution (§10)                                                     */
/* ------------------------------------------------------------------ */

async function callTool(userId, serverId, toolName_, args) {
  const s = SESSIONS.get(key(userId, serverId));
  if (!s || !s.client || s.status !== "connected") {
    return { ok: false, error: "MCP server is not connected" };
  }
  try {
    const res = await withTimeout(
      s.client.callTool({ name: toolName_, arguments: args || {} }),
      CALL_TIMEOUT_MS,
      "MCP tool call timed out"
    );
    // The protocol reports tool-level failure via isError — a response
    // arriving is NOT success (§10).
    const text = (res?.content || [])
      .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
      .join("\n")
      .slice(0, 4000);
    if (res?.isError) {
      return { ok: false, error: text || "MCP tool reported an error" };
    }
    return { ok: true, data: res?.structuredContent ?? text, speak: text };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    // A dead connection should stop advertising tools it cannot run.
    if (/closed|econnrefused|socket|timed out|terminated/i.test(msg)) {
      s.status = "error";
      s.lastError = msg;
      await withdrawTools(userId, serverId);
    }
    return { ok: false, error: msg };
  }
}

function withTimeout(p, ms, message) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(message)), ms)),
  ]);
}

/**
 * Declarations for ONE user: built-ins plus only that user's MCP tools.
 * This is what enforces §6 at the model boundary.
 */
function declarationsForUser(userId) {
  const uid = Number(userId);
  return registry
    .list()
    .filter((t) => t.source !== "mcp" || t.userId === uid)
    .map((t) => t.name);
}

module.exports = {
  connect,
  disconnect,
  callTool,
  statusOf,
  withdrawTools,
  declarationsForUser,
  classifyRisk,
  toolName,
  displayName,
  SESSIONS,
};
