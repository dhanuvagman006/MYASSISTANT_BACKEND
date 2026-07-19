/**
 * GOOGLE ACCOUNT LINK (Gmail + Calendar, read-only)
 * -------------------------------------------------
 * The app asks the user for gmail.readonly + calendar.readonly and sends
 * us the one-time serverAuthCode. We exchange it for a REFRESH TOKEN
 * (long-lived, stored per user) + access tokens (short-lived, cached).
 * The app itself never holds Google tokens.
 *
 * Env: GOOGLE_WEB_CLIENT_ID (already used for sign-in) and
 *      GOOGLE_WEB_CLIENT_SECRET (the same Web client's secret).
 */
const { db } = require("../db");

db.exec(`
  CREATE TABLE IF NOT EXISTS google_tokens (
    user_id       INTEGER PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    access_token  TEXT,
    expires_at    INTEGER,          -- epoch ms
    scopes        TEXT,
    updated_at    INTEGER NOT NULL
  );
`);

const stmts = {
  get: db.prepare("SELECT * FROM google_tokens WHERE user_id = ?"),
  upsert: db.prepare(`
    INSERT INTO google_tokens (user_id, refresh_token, access_token, expires_at, scopes, updated_at)
    VALUES (@user_id, @refresh_token, @access_token, @expires_at, @scopes, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET
      refresh_token = excluded.refresh_token,
      access_token = excluded.access_token,
      expires_at = excluded.expires_at,
      scopes = excluded.scopes,
      updated_at = excluded.updated_at
  `),
  setAccess: db.prepare(
    "UPDATE google_tokens SET access_token = ?, expires_at = ?, updated_at = ? WHERE user_id = ?"
  ),
  delete: db.prepare("DELETE FROM google_tokens WHERE user_id = ?"),
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT = 10_000;

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(TIMEOUT),
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`google token ${r.status}: ${j.error || ""} ${j.error_description || ""}`.trim());
  }
  return j;
}

/** Exchange the app's one-time serverAuthCode → refresh + access token. */
async function connect(userId, serverAuthCode) {
  const j = await tokenRequest({
    grant_type: "authorization_code",
    code: serverAuthCode,
    client_id: process.env.GOOGLE_WEB_CLIENT_ID,
    client_secret: process.env.GOOGLE_WEB_CLIENT_SECRET,
    // Mobile serverAuthCode exchange uses an empty redirect_uri.
    redirect_uri: "",
  });
  if (!j.refresh_token) {
    // Google only returns refresh_token on the FIRST consent. If it's
    // missing and we don't already have one, the user must re-consent.
    const existing = stmts.get.get(userId);
    if (!existing) {
      throw new Error("no refresh_token returned — revoke the app at myaccount.google.com/permissions and connect again");
    }
    stmts.setAccess.run(
      j.access_token,
      Date.now() + (j.expires_in || 3600) * 1000 - 60_000,
      Date.now(),
      userId
    );
    return;
  }
  stmts.upsert.run({
    user_id: userId,
    refresh_token: j.refresh_token,
    access_token: j.access_token || null,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000 - 60_000,
    scopes: j.scope || "",
    updated_at: Date.now(),
  });
}

/** Valid access token for a user, refreshing if needed. null = not linked. */
async function accessToken(userId) {
  const row = stmts.get.get(userId);
  if (!row) return null;
  if (row.access_token && row.expires_at > Date.now()) return row.access_token;
  const j = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
    client_id: process.env.GOOGLE_WEB_CLIENT_ID,
    client_secret: process.env.GOOGLE_WEB_CLIENT_SECRET,
  });
  const exp = Date.now() + (j.expires_in || 3600) * 1000 - 60_000;
  stmts.setAccess.run(j.access_token, exp, Date.now(), userId);
  return j.access_token;
}

function isConnected(userId) {
  return !!stmts.get.get(userId);
}

/** Disconnect: best-effort revoke at Google, then forget locally. */
async function disconnect(userId) {
  const row = stmts.get.get(userId);
  if (row) {
    try {
      await fetch(
        "https://oauth2.googleapis.com/revoke?token=" +
          encodeURIComponent(row.refresh_token),
        { method: "POST", signal: AbortSignal.timeout(TIMEOUT) }
      );
    } catch (_) {}
  }
  stmts.delete.run(userId);
}

module.exports = { connect, accessToken, isConnected, disconnect };
