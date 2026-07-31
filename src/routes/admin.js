/**
 * ADMIN — read-only operational stats for the owner's dashboard/curl.
 * Guarded by a static ADMIN_KEY (X-Admin-Key header); disabled entirely
 * when the env var is unset. Never returns user content — counts only.
 */
const router = require("express").Router();
const crypto = require("crypto");
const billing = require("../billing/store");

router.use((req, res, next) => {
  const key = process.env.ADMIN_KEY || "";
  const got = req.get("X-Admin-Key") || "";
  const ok =
    key.length >= 16 &&
    got.length === key.length &&
    crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key));
  if (!ok) return res.status(404).json({ error: "not found" }); // don't advertise
  next();
});

router.get("/stats", async (_req, res) => {
  res.json({ ts: Date.now(), ...(await billing.stats()) });
});

module.exports = router;
