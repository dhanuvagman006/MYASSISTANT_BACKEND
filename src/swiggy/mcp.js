/**
 * SWIGGY MCP CLIENT (Streamable HTTP, zero dependencies)
 * ------------------------------------------------------
 * A deliberately tiny JSON-RPC client for mcp.swiggy.com/{food|im|dineout}.
 * We skip the full @modelcontextprotocol/sdk: the assistant only ever needs
 * tools/call, and one small file keeps cold-start + memory tight for a
 * container that will serve a lot of traffic.
 *
 * Per-user MCP sessions are cached (Map, 30-min idle TTL). On a stale
 * session (404) we re-initialize once; on 401 we refresh the OAuth token
 * once. Both SSE- and JSON-framed responses are handled.
 */
const tokens = require("./tokens");

const BASE = () => (process.env.SWIGGY_MCP_BASE || "https://mcp.swiggy.com").replace(/\/$/, "");
const TIMEOUT = 20_000;
const PROTOCOL = "2025-06-18";

// userId → { sessionId, at } per server. Sessions are cheap; sweep hourly.
const sessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 1_800_000;
  for (const [k, v] of sessions) if (v.at < cutoff) sessions.delete(k);
}, 3_600_000).unref();

let rpcId = 1;

async function post(server, body, auth, sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${auth}`,
    "mcp-protocol-version": PROTOCOL,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return fetch(`${BASE()}/${server}`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(TIMEOUT),
    body: JSON.stringify(body),
  });
}

/** Reads a JSON-RPC response whether framed as JSON or a one-shot SSE stream. */
async function readRpc(r) {
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const text = await r.text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.id !== undefined && (j.result !== undefined || j.error)) return j;
      } catch { /* keep scanning */ }
    }
    throw new Error("swiggy mcp: empty SSE response");
  }
  return r.json();
}

async function initialize(server, auth) {
  const r = await post(server, {
    jsonrpc: "2.0",
    id: rpcId++,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "myassistant-hari", version: "1.0.0" },
    },
  }, auth);
  if (!r.ok) throw new Error(`swiggy mcp init ${r.status}`);
  const sessionId = r.headers.get("mcp-session-id");
  await readRpc(r); // drain/validate
  // Required by spec before the session is usable.
  await post(server, { jsonrpc: "2.0", method: "notifications/initialized" }, auth, sessionId);
  return sessionId;
}

/**
 * Call one tool as one user. Returns the parsed `{ ... }` payload.
 * @throws Error with .code = "NOT_LINKED" when the user has no Swiggy link.
 */
async function callTool(userId, name, args = {}, server = "food") {
  let auth = await tokens.accessToken(userId);
  if (!auth) {
    const e = new Error("Swiggy account not linked");
    e.code = "NOT_LINKED";
    throw e;
  }

  const key = `${userId}:${server}`;
  let refreshed = false;
  let reinit = false;

  for (;;) {
    let entry = sessions.get(key);
    if (!entry) {
      entry = { sessionId: await initialize(server, auth), at: Date.now() };
      sessions.set(key, entry);
    }
    const r = await post(server, {
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    }, auth, entry.sessionId);

    if (r.status === 401 && !refreshed) {           // token expired mid-flight
      refreshed = true;
      sessions.delete(key);
      auth = await tokens.accessToken(userId);
      if (!auth) { const e = new Error("Swiggy link expired"); e.code = "NOT_LINKED"; throw e; }
      continue;
    }
    if (r.status === 404 && !reinit) {              // session expired server-side
      reinit = true;
      sessions.delete(key);
      continue;
    }
    if (!r.ok) throw new Error(`swiggy ${name} http ${r.status}`);

    entry.at = Date.now();
    const rpc = await readRpc(r);
    if (rpc.error) throw new Error(`swiggy ${name}: ${rpc.error.message || rpc.error.code}`);

    const res = rpc.result || {};
    // MCP tool results carry content blocks; Swiggy returns { success, data }.
    if (res.isError) {
      const msg = res.content?.map((c) => c.text).filter(Boolean).join(" ") || "tool error";
      throw new Error(`swiggy ${name}: ${msg}`);
    }
    if (res.structuredContent) return res.structuredContent;
    const text = res.content?.find((c) => c.type === "text")?.text;
    if (text) { try { return JSON.parse(text); } catch { return { text }; } }
    return res;
  }
}

module.exports = { callTool };
