/**
 * SWIGGY ACCOUNT LINK (Builders Club MCP — OAuth 2.1 + PKCE)
 * ----------------------------------------------------------
 * Mirrors src/google/tokens.js. Each user links their OWN Swiggy account
 * (phone + OTP in the browser); we store the refresh token per user so
 * orders land on their saved addresses. The app never holds Swiggy tokens.
 *
 * The MCP spec mandates discovery + Dynamic Client Registration, so there
 * is no client id to configure — we register ourselves once and cache the
 * registration in SQLite (kv table). Everything is lazy + cached:
 * metadata 24 h, access tokens until 60 s before expiry.
 *
 * Env:
 *   SWIGGY_MCP_BASE      default https://mcp.swiggy.com
 *   SWIGGY_REDIRECT_URI  e.g. http://localhost:3000/swiggy/callback (dev)
 */
const crypto = require("crypto");
const { db } = require("../db");

db.exec(`
  CREATE TABLE IF NOT EXISTS swiggy_tokens (
    user_id       INTEGER PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    access_token  TEXT,
    expires_at    INTEGER,
    updated_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
`);

const stmts = {
  get: db.prepare("SELECT * FROM swiggy_tokens WHERE user_id = ?"),
  upsert: db.prepare(`
    INSERT INTO swiggy_tokens (user_id, refresh_token, access_token, expires_at, updated_at)
    VALUES (@user_id, @refresh_token, @access_token, @expires_at, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET
      refresh_token = excluded.refresh_token,
      access_token  = excluded.access_token,
      expires_at    = excluded.expires_at,
      updated_at    = excluded.updated_at
  `),
  setAccess: db.prepare(
    "UPDATE swiggy_tokens SET access_token = ?, expires_at = ?, refresh_token = ?, updated_at = ? WHERE user_id = ?"
  ),
  del: db.prepare("DELETE FROM swiggy_tokens WHERE user_id = ?"),
  kvGet: db.prepare("SELECT v FROM kv WHERE k = ?"),
  kvSet: db.prepare(
    "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
  ),
};

const BASE = () => (process.env.SWIGGY_MCP_BASE || "https://mcp.swiggy.com").replace(/\/$/, "");
const REDIRECT = () => process.env.SWIGGY_REDIRECT_URI || "http://localhost:3000/swiggy/callback";
const TIMEOUT = 10_000;
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function jfetch(url, opts = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`swiggy ${url.split("/").pop()} ${r.status}: ${j.error || ""} ${j.error_description || ""}`.trim());
  return j;
}

// ---- OAuth server metadata (RFC 8414 discovery, 24 h in-process cache) ----
let metaCache = null; // { meta, at }
async function metadata() {
  if (metaCache && Date.now() - metaCache.at < 86_400_000) return metaCache.meta;
  let meta;
  try {
    meta = await jfetch(`${BASE()}/.well-known/oauth-authorization-server`);
  } catch {
    // Fallback for servers exposing protected-resource metadata instead.
    const pr = await jfetch(`${BASE()}/.well-known/oauth-protected-resource`);
    meta = await jfetch(`${String(pr.authorization_servers?.[0] || BASE()).replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
  }
  if (!meta.authorization_endpoint || !meta.token_endpoint) throw new Error("swiggy: OAuth metadata incomplete");
  metaCache = { meta, at: Date.now() };
  return meta;
}

// ---- Dynamic Client Registration (once, persisted in kv) ----
async function clientReg() {
  const row = stmts.kvGet.get("swiggy_client");
  if (row) {
    const c = JSON.parse(row.v);
    if (c.redirect_uris?.includes(REDIRECT())) return c;
  }
  const meta = await metadata();
  if (!meta.registration_endpoint) throw new Error("swiggy: no registration endpoint");
  const c = await jfetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "MyAssistant Hari",
      redirect_uris: [REDIRECT()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client + PKCE
      scope: "mcp:tools mcp:resources mcp:prompts",
    }),
  });
  stmts.kvSet.run("swiggy_client", JSON.stringify(c));
  return c;
}

// ---- PKCE flow ----
// state → { userId, verifier, at }; tiny, self-cleaning (10-min TTL).
const pending = new Map();
function sweepPending() {
  const cutoff = Date.now() - 600_000;
  for (const [k, v] of pending) if (v.at < cutoff) pending.delete(k);
}

/** Step 1: build the browser URL the app should open. */
async function beginLink(userId) {
  sweepPending();
  const [meta, client] = await Promise.all([metadata(), clientReg()]);
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  pending.set(state, { userId, verifier, at: Date.now() });
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", client.client_id);
  u.searchParams.set("redirect_uri", REDIRECT());
  u.searchParams.set("scope", "mcp:tools mcp:resources mcp:prompts");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", b64url(crypto.createHash("sha256").update(verifier).digest()));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** Step 2: the OAuth callback exchanges code → tokens. Returns userId. */
async function completeLink(state, code) {
  const p = pending.get(state);
  if (!p || Date.now() - p.at > 600_000) throw new Error("swiggy: link expired — try again");
  pending.delete(state);
  const [meta, client] = await Promise.all([metadata(), clientReg()]);
  const t = await jfetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT(),
      client_id: client.client_id,
      code_verifier: p.verifier,
    }).toString(),
  });
  if (!t.refresh_token) throw new Error("swiggy: no refresh token returned");
  stmts.upsert.run({
    user_id: p.userId,
    refresh_token: t.refresh_token,
    access_token: t.access_token || null,
    expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
    updated_at: Date.now(),
  });
  return p.userId;
}

function isLinked(userId) {
  return !!stmts.get.get(userId);
}

function unlink(userId) {
  stmts.del.run(userId);
}

/** Valid access token for the user; refreshes when < 60 s of life left. */
async function accessToken(userId) {
  const row = stmts.get.get(userId);
  if (!row) return null;
  if (row.access_token && row.expires_at && row.expires_at - Date.now() > 60_000) {
    return row.access_token;
  }
  const [meta, client] = await Promise.all([metadata(), clientReg()]);
  const t = await jfetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
      client_id: client.client_id,
    }).toString(),
  }).catch((e) => {
    // Refresh token revoked/expired → force a fresh link instead of looping.
    if (/40[01]/.test(e.message)) { stmts.del.run(userId); return null; }
    throw e;
  });
  if (!t) return null;
  stmts.setAccess.run(
    t.access_token,
    t.expires_in ? Date.now() + t.expires_in * 1000 : null,
    t.refresh_token || row.refresh_token, // rotation-safe
    Date.now(),
    userId
  );
  return t.access_token;
}

module.exports = { beginLink, completeLink, isLinked, unlink, accessToken };
