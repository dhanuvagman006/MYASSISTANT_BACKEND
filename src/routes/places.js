/**
 * NEARBY PLACES (C3) — powers the Today tab's Nearby section.
 *   GET /places?q=restaurants&lat=..&lng=..   → { places: [...] }
 *   GET /places/photo?ref=<photoRef>          → the photo bytes
 * The photo endpoint proxies Google Place photos so the API key never
 * reaches the client. Photos are immutable → long browser/app cache.
 */
const router = require("express").Router();
const { searchPlaces } = require("../services/tools/places");

router.get("/", async (req, res) => {
  const q = String(req.query.q || "").slice(0, 120).trim();
  if (!q) return res.status(400).json({ error: "q required" });
  const lat = parseFloat(req.query.lat ?? req.get("X-Geo-Lat"));
  const lng = parseFloat(req.query.lng ?? req.get("X-Geo-Lng"));
  try {
    const list = await searchPlaces({ q, lat, lng });
    res.json({ places: list });
  } catch (e) {
    console.error("places:", e.message);
    res.status(502).json({ error: "places failed" });
  }
});

router.get("/photo", async (req, res) => {
  const ref = String(req.query.ref || "");
  const key = process.env.GOOGLE_PLACES_API_KEY;
  // Only well-formed Google photo resource names pass through.
  if (!key || !/^places\/[\w-]+\/photos\/[\w-]+$/.test(ref)) {
    return res.status(404).end();
  }
  try {
    const r = await fetch(
      `https://places.googleapis.com/v1/${ref}/media?maxWidthPx=480&key=${key}`,
      { signal: AbortSignal.timeout(8000), redirect: "follow" }
    );
    if (!r.ok) return res.status(404).end();
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (_) {
    res.status(404).end();
  }
});

module.exports = router;
