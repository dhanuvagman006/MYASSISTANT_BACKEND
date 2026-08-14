/**
 * MCP SERVER REGISTRY — persistence + credential protection.
 *
 * §5/§13: credentials must not sit in the database as ordinary plaintext
 * configuration and must never be returned by a GET. Two mechanisms:
 *
 *   1. Secrets live in a SEPARATE column (`secrets_enc`) from the public
 *      config, encrypted with AES-256-GCM using a key derived from
 *      MCP_SECRET_KEY (or JWT_SECRET as a fallback so a dev install still
 *      protects tokens at rest).
 *   2. `toClient()` is the ONLY serialiser used by the routes and it can
 *      not emit secrets — it reports `hasSecrets: true` and nothing more.
 *
 * If the key changes, previously stored secrets simply fail to decrypt and
 * the server is marked as needing re-authentication. That is deliberate:
 * silently returning garbage credentials to a live connection would be
 * worse than an honest "reconnect required".
 */
const crypto = require("crypto");

const ALGO = "aes-256-gcm";

function keyBytes() {
  const raw =
    process.env.MCP_SECRET_KEY ||
    process.env.JWT_SECRET ||
    "";
  if (!raw) throw new Error("MCP_SECRET_KEY (or JWT_SECRET) must be set to store MCP credentials");
  // Derive a stable 32-byte key from whatever length secret is configured.
  return crypto.createHash("sha256").update(String(raw)).digest();
}

function encryptSecrets(obj) {
  if (!obj || !Object.keys(obj).length) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, keyBytes(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptSecrets(blob) {
  if (!blob) return {};
  try {
    const b = Buffer.from(blob, "base64");
    const iv = b.subarray(0, 12);
    const tag = b.subarray(12, 28);
    const enc = b.subarray(28);
    const d = crypto.createDecipheriv(ALGO, keyBytes(), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString("utf8"));
  } catch (_) {
    // Wrong/rotated key or tampered row — never return partial credentials.
    return null;
  }
}

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id                BIGSERIAL PRIMARY KEY,
      user_id           INTEGER NOT NULL,
      name              TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      transport         TEXT NOT NULL DEFAULT 'http',  -- http | sse | stdio
      config            JSONB NOT NULL DEFAULT '{}',   -- PUBLIC config only
      secrets_enc       TEXT,                          -- AES-256-GCM blob
      enabled           INTEGER NOT NULL DEFAULT 1,
      status            TEXT NOT NULL DEFAULT 'disconnected',
        -- connecting | connected | disconnected | error | disabled | reconnecting
      last_error        TEXT NOT NULL DEFAULT '',
      tools_cache       JSONB NOT NULL DEFAULT '[]',   -- last discovered tools
      created_at        BIGINT NOT NULL,
      updated_at        BIGINT NOT NULL,
      last_connected_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_user ON mcp_servers(user_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_user_name
      ON mcp_servers(user_id, lower(name));
  `);
}

/**
 * The ONLY shape sent to the app. Secrets are structurally absent — there
 * is no code path that puts them in this object (§13).
 */
function toClient(row, live = null) {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    transport: row.transport,
    config: publicConfig(row.config),
    hasSecrets: Boolean(row.secrets_enc),
    enabled: row.enabled === 1,
    status: live?.status || (row.enabled === 1 ? row.status : "disabled"),
    lastError: live?.lastError ?? row.last_error,
    toolCount: Array.isArray(row.tools_cache) ? row.tools_cache.length : 0,
    tools: (Array.isArray(row.tools_cache) ? row.tools_cache : []).map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
    })),
    createdAt: Number(row.created_at),
    lastConnectedAt: row.last_connected_at ? Number(row.last_connected_at) : null,
  };
}

/** Strips anything secret-shaped that a client may have put in `config`. */
function publicConfig(config) {
  const c = { ...(config || {}) };
  for (const k of Object.keys(c)) {
    if (/token|secret|key|password|authorization|credential/i.test(k)) delete c[k];
  }
  if (c.headers && typeof c.headers === "object") {
    c.headers = Object.fromEntries(
      Object.entries(c.headers).filter(
        ([h]) => !/authorization|token|key|secret|cookie/i.test(h)
      )
    );
  }
  return c;
}

/** Splits an incoming payload into public config and secret material. */
function splitSecrets(body = {}) {
  const config = { ...(body.config || {}) };
  const secrets = { ...(body.secrets || {}) };
  // Anything secret-shaped that arrived in `config` is moved, not dropped —
  // the user meant to send it, it just must not be stored in the clear.
  for (const [k, v] of Object.entries(config)) {
    if (/token|secret|key|password|authorization|credential/i.test(k)) {
      secrets[k] = v;
      delete config[k];
    }
  }
  if (config.headers && typeof config.headers === "object") {
    const keep = {};
    for (const [h, v] of Object.entries(config.headers)) {
      if (/authorization|token|key|secret|cookie/i.test(h)) {
        secrets.headers = { ...(secrets.headers || {}), [h]: v };
      } else keep[h] = v;
    }
    config.headers = keep;
  }
  return { config, secrets };
}

module.exports = {
  migrate,
  encryptSecrets,
  decryptSecrets,
  toClient,
  publicConfig,
  splitSecrets,
};
