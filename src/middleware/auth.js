/**
 * Simple shared-secret auth between the Android app and this backend.
 * The app sends X-App-Key; requests without it are rejected.
 * (Replace with per-user Google sign-in token verification when F1 lands:
 * verify the Google ID token here and attach req.user.)
 */
function appAuth(req, res, next) {
  const expected = process.env.APP_API_KEY;
  if (!expected) return next(); // no key configured yet (local dev)
  if (req.get("X-App-Key") !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

module.exports = { appAuth };
