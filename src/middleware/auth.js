/**
 * AUTH — two modes:
 *
 * 1. Google ID token (production, F1): the app sends
 *    `Authorization: Bearer <googleIdToken>`. We verify the signature
 *    against Google's public keys and the audience against our
 *    GOOGLE_WEB_CLIENT_ID. On success, req.user = { sub, email, name }.
 *    `sub` is Google's permanent user ID — use it as the primary key
 *    for memories, reminders and notes.
 *
 * 2. X-App-Key shared secret (dev fallback): only honoured when
 *    ALLOW_APP_KEY=true, so it can't be left on in production by accident.
 */
const { OAuth2Client } = require("google-auth-library");

const client = new OAuth2Client();
const tokenCache = new Map(); // token → { user, exp } to avoid re-verifying every request

async function verifyGoogleToken(idToken) {
  const cached = tokenCache.get(idToken);
  if (cached && cached.exp > Date.now()) return cached.user;

  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_WEB_CLIENT_ID,
  });
  const p = ticket.getPayload();
  const user = { sub: p.sub, email: p.email, name: p.name };

  // Cache until the token's own expiry (Google ID tokens live ~1 hour)
  tokenCache.set(idToken, { user, exp: p.exp * 1000 });
  if (tokenCache.size > 10_000) {
    // Evict expired entries first; only wipe everything if that wasn't enough.
    const now = Date.now();
    for (const [t, v] of tokenCache) if (v.exp <= now) tokenCache.delete(t);
    if (tokenCache.size > 10_000) tokenCache.clear();
  }
  return user;
}

async function appAuth(req, res, next) {
  // Dev mode: skip auth entirely until F1 OAuth setup is done.
  // NEVER leave this on in production — anyone could use your AI budget.
  if (process.env.AUTH_DISABLED === "true") {
    req.user = { sub: "anonymous-dev", email: null, name: "Dev User" };
    return next();
  }
  try {
    const authz = req.get("Authorization") || "";
    if (authz.startsWith("Bearer ")) {
      req.user = await verifyGoogleToken(authz.slice(7));
      return next();
    }
    if (
      process.env.ALLOW_APP_KEY === "true" &&
      process.env.APP_API_KEY &&
      req.get("X-App-Key") === process.env.APP_API_KEY
    ) {
      req.user = { sub: "dev", email: "dev@local", name: "Dev" };
      return next();
    }
    return res.status(401).json({ error: "sign in required" });
  } catch (e) {
    return res.status(401).json({ error: "invalid or expired token" });
  }
}

module.exports = { appAuth };
