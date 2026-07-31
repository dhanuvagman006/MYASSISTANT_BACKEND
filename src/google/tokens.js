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
const { one, run } = require("../db");

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
    const existing = await one("SELECT * FROM google_tokens WHERE user_id = $1", [userId]);
    if (!existing) {
      throw new Error("no refresh_token returned — revoke the app at myaccount.google.com/permissions and connect again");
    }
    await run(
      "UPDATE google_tokens SET access_token = $1, expires_at = $2, updated_at = $3 WHERE user_id = $4",
      [j.access_token, Date.now() + (j.expires_in || 3600) * 1000 - 60_000, Date.now(), userId]
    );
    return;
  }
  await run(
    `INSERT INTO google_tokens (user_id, refresh_token, access_token, expires_at, scopes, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       refresh_token = EXCLUDED.refresh_token,
       access_token = EXCLUDED.access_token,
       expires_at = EXCLUDED.expires_at,
       scopes = EXCLUDED.scopes,
       updated_at = EXCLUDED.updated_at`,
    [userId, j.refresh_token, j.access_token || null,
     Date.now() + (j.expires_in || 3600) * 1000 - 60_000, j.scope || "", Date.now()]
  );
}

/** Valid access token for a user, refreshing if needed. null = not linked. */
async function accessToken(userId) {
  const row = await one("SELECT * FROM google_tokens WHERE user_id = $1", [userId]);
  if (!row) return null;
  if (row.access_token && row.expires_at > Date.now()) return row.access_token;
  const j = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
    client_id: process.env.GOOGLE_WEB_CLIENT_ID,
    client_secret: process.env.GOOGLE_WEB_CLIENT_SECRET,
  });
  const exp = Date.now() + (j.expires_in || 3600) * 1000 - 60_000;
  await run(
    "UPDATE google_tokens SET access_token = $1, expires_at = $2, updated_at = $3 WHERE user_id = $4",
    [j.access_token, exp, Date.now(), userId]
  );
  return j.access_token;
}

async function isConnected(userId) {
  return !!(await one("SELECT 1 FROM google_tokens WHERE user_id = $1", [userId]));
}

/** Disconnect: best-effort revoke at Google, then forget locally. */
async function disconnect(userId) {
  const row = await one("SELECT * FROM google_tokens WHERE user_id = $1", [userId]);
  if (row) {
    try {
      await fetch(
        "https://oauth2.googleapis.com/revoke?token=" +
          encodeURIComponent(row.refresh_token),
        { method: "POST", signal: AbortSignal.timeout(TIMEOUT) }
      );
    } catch (_) {}
  }
  await run("DELETE FROM google_tokens WHERE user_id = $1", [userId]);
}

module.exports = { connect, accessToken, isConnected, disconnect };
