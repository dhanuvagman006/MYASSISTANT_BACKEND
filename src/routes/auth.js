/**
 * AUTH ROUTES
 * -----------
 * POST /auth/signup  { email, password, name }        → { token, user }
 * POST /auth/login   { email, password }              → { token, user }
 * POST /auth/google  { idToken }                      → { token, user }
 * POST /auth/apple   { identityToken, name? }         → { token, user }
 * GET  /auth/me      (Authorization: Bearer <token>)  → { user }
 *
 * All flows end the same way: we issue OUR OWN session JWT (30 days).
 * The app stores that one token and sends it on every request — it never
 * needs to juggle Google/Apple token refresh.
 */
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { createRemoteJWKSet, jwtVerify } = require("jose");

const db = require("../db");
const memory = require("../memory/store");

const JWT_SECRET = process.env.JWT_SECRET;
const SESSION_DAYS = 30;

const googleClient = new OAuth2Client();
// Apple publishes its signing keys here; jose caches them for us.
const appleJwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

function issueSession(user) {
  return jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
}

function respond(res, user) {
  res.json({ token: issueSession(user), user: db.publicUser(user) });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------- EMAIL ----------------

router.post("/signup", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!EMAIL_RE.test(email || "")) {
    return res.status(400).json({ error: "valid email required" });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  if (db.findByEmail(email)) {
    return res.status(409).json({ error: "an account with this email already exists" });
  }
  const user = db.createUser({
    email,
    name: typeof name === "string" ? name.trim().slice(0, 100) : null,
    passwordHash: await bcrypt.hash(password, 10),
    provider: "email",
  });
  // First memories: whatever the user gave us at sign-up.
  memory.seedProfile(user.id, { name: user.name, email: user.email });
  respond(res, user);
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? db.findByEmail(email) : null;
  // Same error for "no user" and "wrong password" — don't leak which emails exist.
  if (!user || !user.password_hash || !(await bcrypt.compare(password || "", user.password_hash))) {
    return res.status(401).json({ error: "incorrect email or password" });
  }
  respond(res, user);
});

// ---------------- GOOGLE ----------------

router.post("/google", async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: "idToken required" });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_WEB_CLIENT_ID,
    });
    const p = ticket.getPayload();
    const user = db.upsertSocialUser({
      provider: "google",
      sub: p.sub,
      email: p.email,
      name: p.name,
    });
    // Seed memory from the Google profile: name, given name, email, photo,
    // locale. Runs on every Google sign-in (upsert), so a later profile
    // change on Google's side refreshes these too.
    memory.seedProfile(user.id, {
      name: p.name,
      givenName: p.given_name,
      email: p.email,
      picture: p.picture,
      locale: p.locale,
    });
    respond(res, user);
  } catch {
    res.status(401).json({ error: "invalid Google token" });
  }
});

// ---------------- APPLE ----------------

router.post("/apple", async (req, res) => {
  const { identityToken, name } = req.body || {};
  if (!identityToken) return res.status(400).json({ error: "identityToken required" });
  try {
    const { payload } = await jwtVerify(identityToken, appleJwks, {
      issuer: "https://appleid.apple.com",
      audience: process.env.APPLE_BUNDLE_ID, // e.g. com.yourorg.myassistant
    });
    const user = db.upsertSocialUser({
      provider: "apple",
      sub: payload.sub,
      email: payload.email || null,
      // Apple only sends the name on FIRST sign-in, and only to the app —
      // the app forwards it here so we don't lose it.
      name: typeof name === "string" ? name.trim().slice(0, 100) : null,
    });
    memory.seedProfile(user.id, { name: user.name, email: user.email });
    respond(res, user);
  } catch {
    res.status(401).json({ error: "invalid Apple token" });
  }
});

// ---------------- SESSION ----------------

router.get("/me", (req, res) => {
  const authz = req.get("Authorization") || "";
  if (!authz.startsWith("Bearer ")) return res.status(401).json({ error: "token required" });
  try {
    const { uid } = jwt.verify(authz.slice(7), JWT_SECRET);
    const user = db.findById(uid);
    if (!user) return res.status(401).json({ error: "account not found" });
    res.json({ user: db.publicUser(user) });
  } catch {
    res.status(401).json({ error: "invalid or expired session" });
  }
});

module.exports = router;
