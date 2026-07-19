/**
 * REGION → LANGUAGE from the caller's IP.
 * GET /region -> { locale, state, country }
 *
 * No app permissions, no GPS: the server geo-locates the request IP
 * (ip-api.com, free tier) and maps Indian states to their language —
 * Karnataka -> kn_IN, Kerala -> ml_IN, Tamil Nadu -> ta_IN, etc.
 * Private/LAN IPs (dev on Wi-Fi) fall back to the server's own public
 * IP — same network, same state, still correct.
 */
const router = require("express").Router();

const STATE_LOCALE = {
  karnataka: "kn_IN",
  "tamil nadu": "ta_IN",
  kerala: "ml_IN",
  "andhra pradesh": "te_IN",
  telangana: "te_IN",
  maharashtra: "mr_IN",
  gujarat: "gu_IN",
  punjab: "pa_IN",
  "west bengal": "bn_IN",
  tripura: "bn_IN",
  odisha: "or_IN",
  assam: "as_IN",
  "uttar pradesh": "hi_IN",
  bihar: "hi_IN",
  "madhya pradesh": "hi_IN",
  rajasthan: "hi_IN",
  haryana: "hi_IN",
  delhi: "hi_IN",
  "national capital territory of delhi": "hi_IN",
  jharkhand: "hi_IN",
  chhattisgarh: "hi_IN",
  uttarakhand: "hi_IN",
  "himachal pradesh": "hi_IN",
  "jammu and kashmir": "ur_IN",
  chandigarh: "hi_IN",
  puducherry: "ta_IN",
  goa: "en_IN",
};

const COUNTRY_LOCALE = {
  IN: "hi_IN", PK: "ur_PK", BD: "bn_BD", LK: "si_LK", NP: "ne_NP",
  FR: "fr_FR", DE: "de_DE", ES: "es_ES", IT: "it_IT", PT: "pt_PT",
  BR: "pt_BR", MX: "es_MX", RU: "ru_RU", JP: "ja_JP", KR: "ko_KR",
  CN: "zh_CN", TW: "zh_TW", TH: "th_TH", VN: "vi_VN", ID: "id_ID",
  TR: "tr_TR", SA: "ar_SA", AE: "ar_AE", EG: "ar_EG",
};

function isPrivate(ip) {
  return (
    !ip ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("127.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("fe80")
  );
}

// Tiny cache so we don't hammer the free geo service (45 req/min limit).
const cache = new Map(); // ip -> { at, payload }
const CACHE_MS = 10 * 60 * 1000;

router.get("/", async (req, res) => {
  let ip = (req.ip || "").replace(/^::ffff:/, "");
  if (isPrivate(ip)) ip = ""; // ip-api with empty path = the server's own IP

  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.payload);

  try {
    const r = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,countryCode,regionName`,
      { signal: AbortSignal.timeout(6000) }
    );
    const data = await r.json();
    if (data.status !== "success") throw new Error("geo lookup failed");

    const country = (data.countryCode || "").toUpperCase();
    const state = (data.regionName || "").trim();
    let locale = null;
    if (country === "IN") {
      locale = STATE_LOCALE[state.toLowerCase()] || "hi_IN";
    } else {
      locale = COUNTRY_LOCALE[country] || null;
    }

    const payload = { locale, state, country };
    cache.set(ip, { at: Date.now(), payload });
    res.json(payload);
  } catch (e) {
    res.json({ locale: null, state: null, country: null });
  }
});

module.exports = router;
