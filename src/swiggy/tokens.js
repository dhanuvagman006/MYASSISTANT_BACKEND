/**
 * SWIGGY ACCOUNT LINK (Builders Club MCP — OAuth 2.1 + PKCE)
 * ----------------------------------------------------------
 * Mirrors src/google/tokens.js. Each user links their OWN Swiggy account
 * (phone + OTP in the browser); we store the refresh token per user so
 * orders land on their saved addresses. The app never holds Swiggy tokens.
 *
 * The MCP spec mandates discovery + Dynamic Client Registration, so there
 * is no client id to configure — we register ourselves once and cache the
 * registration in Postgres (kv table). Everything is lazy + cached:
 * metadata 24 h, access tokens until 60 s before expiry.
 *
 * Env:
 *   SWIGGY_MCP_BASE      default https://mcp.swiggy.com
 *   SWIGGY_REDIRECT_URI  e.g. http://localhost:3000/swiggy/callback (dev)
 */
const crypto = require("crypto");
const { query, one, run } = require("../db");

const BASE = () => (process.env.SWIGGY_MCP_BASE || "https://mcp.swiggy.com").replace(/\/$/, "");
// Redirect URI resolution order:
//   1. SWIGGY_REDIRECT_URI          — explicit override
//   2. PUBLIC_BASE_URL/swiggy/callback — the deployed server's own URL
//   3. localhost:3000               — local dev ONLY
// The localhost fallback used to win silently in production, so Swiggy
// bounced users' phones to localhost → ERR_CONNECTION_REFUSED and the
// link never completed.
const REDIRECT = () => {
  if (process.env.SWIGGY_REDIRECT_URI) return process.env.SWIGGY_REDIRECT_URI;
  const pub = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (pub) return `${pub}/swiggy/callback`;
  return "http://localhost:3000/swiggy/callback";
};
const TIMEOUT = 10_000;

// Refresh tokens are only issued when the client asks for offline_access;
// without it Swiggy returned only a short-lived access token and the link
// died with "no refresh token returned". Request it unless the server's
// metadata explicitly says it's unsupported.
const BASE_SCOPES = "mcp:tools mcp:resources mcp:prompts";
async function scopeString() {
  const meta = await metadata();
  const supported = meta.scopes_supported;
  const offline = !Array.isArray(supported) || supported.includes("offline_access");
  return offline ? `${BASE_SCOPES} offline_access` : BASE_SCOPES;
}
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
  const scope = await scopeString();
  const row = await one("SELECT v FROM kv WHERE k = $1", ["swiggy_client"]);
  if (row) {
    const c = JSON.parse(row.v);
    // Re-register when the redirect or requested scopes changed.
    if (c.redirect_uris?.includes(REDIRECT()) && c._requested_scope === scope) return c;
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
      scope,
    }),
  });
  c._requested_scope = scope; // our fingerprint, not part of the server reply
  await run(
    "INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v",
    ["swiggy_client", JSON.stringify(c)]
  );
  return c;
}

// ---- PKCE flow ----
// state → { userId, verifier, at }; 10-min TTL. Persisted in the kv
// table (key 'swiggy_pending:<state>') so an in-flight link survives a
// server restart — in dev the container restarts constantly (env edits,
// nodemon), and an in-memory map made every such restart kill the link
// mid-OTP with "link expired".
const PENDING_TTL = 600_000;
const pendingKey = (state) => `swiggy_pending:${state}`;
async function pendingSet(state, data) {
  await run(
    "INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v",
    [pendingKey(state), JSON.stringify(data)]
  );
}
async function pendingTake(state) {
  // Read-and-delete in one step: a state is single-use.
  const row = await one("DELETE FROM kv WHERE k = $1 RETURNING v", [pendingKey(state)]);
  if (!row) return null;
  const p = JSON.parse(row.v);
  return Date.now() - p.at > PENDING_TTL ? null : p;
}
async function sweepPending() {
  const cutoff = Date.now() - PENDING_TTL;
  for (const { k, v } of await query("SELECT k, v FROM kv WHERE k LIKE 'swiggy_pending:%'")) {
    try {
      if (JSON.parse(v).at < cutoff) await run("DELETE FROM kv WHERE k = $1", [k]);
    } catch {
      await run("DELETE FROM kv WHERE k = $1", [k]);
    }
  }
}

/** Step 1: build the browser URL the app should open. */
async function beginLink(userId) {
  await sweepPending();
  // Better a clear error than a browser tab pointing at localhost.
  if (process.env.NODE_ENV === "production" && REDIRECT().includes("localhost")) {
    throw new Error("swiggy: set PUBLIC_BASE_URL or SWIGGY_REDIRECT_URI in production");
  }
  const [meta, client] = await Promise.all([metadata(), clientReg()]);
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  await pendingSet(state, { userId, verifier, at: Date.now() });
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", client.client_id);
  u.searchParams.set("redirect_uri", REDIRECT());
  u.searchParams.set("scope", await scopeString());
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", b64url(crypto.createHash("sha256").update(verifier).digest()));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** Step 2: the OAuth callback exchanges code → tokens. Returns userId. */
async function completeLink(state, code) {
  const p = await pendingTake(state);
  if (!p) throw new Error("swiggy: link expired — try again");
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
  // Prefer a refresh token, but if the server still won't grant one,
  // an access-token-only link is better than no link: store it with an
  // empty refresh token and let accessToken() serve it until expiry.
  if (!t.refresh_token && !t.access_token) throw new Error("swiggy: no tokens returned");
  await run(
    `INSERT INTO swiggy_tokens (user_id, refresh_token, access_token, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       refresh_token = EXCLUDED.refresh_token,
       access_token  = EXCLUDED.access_token,
       expires_at    = EXCLUDED.expires_at,
       updated_at    = EXCLUDED.updated_at`,
    [p.userId, t.refresh_token || "", t.access_token || null,
     t.expires_in ? Date.now() + t.expires_in * 1000 : null, Date.now()]
  );
  return p.userId;
}

async function isLinked(userId) {
  return !!(await one("SELECT 1 FROM swiggy_tokens WHERE user_id = $1", [userId]));
}

async function unlink(userId) {
  await run("DELETE FROM swiggy_tokens WHERE user_id = $1", [userId]);
}

/** Valid access token for the user; refreshes when < 60 s of life left. */
async function accessToken(userId) {
  const row = await one("SELECT * FROM swiggy_tokens WHERE user_id = $1", [userId]);
  if (!row) return null;
  if (row.access_token && row.expires_at && row.expires_at - Date.now() > 60_000) {
    return row.access_token;
  }
  // Access-token-only link (no refresh token granted): once it expires
  // there is nothing to refresh with — drop the row so /status shows
  // "not linked" and the user re-links instead of getting silent 401s.
  if (!row.refresh_token) {
    await run("DELETE FROM swiggy_tokens WHERE user_id = $1", [userId]);
    return null;
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
    if (/40[01]/.test(e.message)) { return run("DELETE FROM swiggy_tokens WHERE user_id = $1", [userId]).then(() => null); }
    throw e;
  });
  if (!t) return null;
  await run(
    "UPDATE swiggy_tokens SET access_token = $1, expires_at = $2, refresh_token = $3, updated_at = $4 WHERE user_id = $5",
    [t.access_token, t.expires_in ? Date.now() + t.expires_in * 1000 : null,
     t.refresh_token || row.refresh_token /* rotation-safe */, Date.now(), userId]
  );
  return t.access_token;
}

module.exports = { beginLink, completeLink, isLinked, unlink, accessToken };
