/**
 * REQUEST AUTH for protected routes (/chat, and future user data routes).
 *
 * Priority:
 *  1. Session JWT (issued by /auth/*) — `Authorization: Bearer <token>`.
 *     This is the normal production path for email, Google AND Apple users.
 *  2. X-App-Key shared secret — dev fallback, only when ALLOW_APP_KEY=true.
 *  3. AUTH_DISABLED=true — dev only; the server refuses to boot with this
 *     in production (see server.js).
 *
 * On success: req.user = { sub, email, name } where sub is our DB user id.
 */
const jwt = require("jsonwebtoken");
const db = require("../db");

async function appAuth(req, res, next) {
  if (process.env.AUTH_DISABLED === "true") {
    req.user = { sub: "anonymous-dev", email: null, name: "Dev User" };
    return next();
  }
  try {
    const authz = req.get("Authorization") || "";
    if (authz.startsWith("Bearer ")) {
      const { uid } = jwt.verify(authz.slice(7), process.env.JWT_SECRET);
      const user = db.findById(uid);
      if (!user) return res.status(401).json({ error: "account not found" });
      req.user = { sub: String(user.id), email: user.email, name: user.name };
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
