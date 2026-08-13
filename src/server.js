require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// Sessions are signed with this — the server can't run without it.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error("FATAL: JWT_SECRET must be set (32+ random characters).");
  process.exit(1);
}

const configRoute = require("./routes/config");
const chatRoute = require("./routes/chat");
const sttRoute = require("./routes/stt");
const ttsRoute = require("./routes/tts");
const regionRoute = require("./routes/region");
const authRoute = require("./routes/auth");
const { appAuth } = require("./middleware/auth");

// Safety guard: never boot in production with auth switched off.
// This is what actually stops AUTH_DISABLED=true from leaking into prod.
if (process.env.NODE_ENV === "production" && process.env.AUTH_DISABLED === "true") {
  console.error("FATAL: AUTH_DISABLED=true is not allowed in production. Remove it and redeploy.");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);
app.use(helmet());

// CORS — native mobile apps don't enforce it, but web-origin callers do:
// the D-ID hosted face page's JS, any future web client, and local dev
// tools. Permissive-by-default is safe here because real protection is
// the auth layer (JWT / app key), not the origin.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-App-Key, X-TZ-Offset, X-Geo-Lat, X-Geo-Lng, X-Style-Tone, X-Style-Length, Last-Event-ID"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- METRICS (/metrics, Prometheus format) ----
// Powers the external monitoring VPS: request rate, latency histograms,
// status codes per route, plus Node process/heap defaults.
// Protected by METRICS_TOKEN when set (send: Authorization: Bearer <token>)
// so the endpoint can sit behind the public ingress without leaking
// traffic patterns to the world.
const promBundle = require("express-prom-bundle");
app.use((req, res, next) => {
  const t = process.env.METRICS_TOKEN;
  if (req.path === "/metrics" && t && req.get("Authorization") !== `Bearer ${t}`) {
    return res.status(404).json({ error: "not found" }); // don't advertise
  }
  next();
});
app.use(
  promBundle({
    includeMethod: true,
    includePath: true,
    metricsPath: "/metrics",
    promClient: { collectDefaultMetrics: {} },
    // Collapse ids so metrics stay low-cardinality.
    normalizePath: [
      ["^/docs/\\d+.*", "/docs/#id"],
      ["^/reminders/\\d+", "/reminders/#id"],
      ["^/agent-call/plivo/[^/]+/", "/agent-call/plivo/#id/"],
      ["^/agent-call/[a-f0-9]{16,}", "/agent-call/#id"],
    ],
  })
);
app.use(
  express.json({
    limit: "2mb",
    // Razorpay signs the RAW bytes — keep them for webhook verification.
    verify: (req, _res, buf) => {
    },
  })
);

// Basic abuse protection: 60 requests/minute per IP
app.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true }));

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Public within the app: remote config (no secrets inside it)
app.use("/config", configRoute);

// Public APK download for the self-hosted update channel (sideload builds)
app.use("/app", require("./routes/appUpdate").router);

// Sign-up/sign-in — extra-tight limit to slow brute-force attempts
app.use(
  "/auth",
  rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true }),
  authRoute
);

// PER-USER rate limit (on top of the per-IP one): a single hot account
// can't drain the AI quota for everyone behind the same NAT/proxy.
const perUserLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  keyGenerator: (req) => String(req.user?.sub || req.ip),
});

// AGENT CALLS — Hari phones a contact and reports back.
// Plivo webhooks are PUBLIC (Plivo can't send our app key); they are guarded
// by a per-call token embedded in the path and MUST be mounted before the
// app-facing routes so they don't hit appAuth.
const agentCall = require("./routes/agentCall");
app.use("/agent-call/plivo", agentCall.webhooks);
app.use("/agent-call", appAuth, perUserLimit, agentCall.router);

// Chat requires the app key so strangers can't burn your AI credits.
// Order: authenticate → per-user throttle → plan allowance → handler.
app.use("/chat", appAuth, perUserLimit, chatRoute);

// ASSISTANT — the realtime voice-loop module the app's home screen uses
// (session + SSE event stream + mic-clip turns). The SSE stream route
// authenticates with a per-session random token (?token=…) because
// EventSource clients can't attach an Authorization header; every other
// assistant route sits behind the normal appAuth like /chat does.
const assistantRoutes = require("./assistant/routes");
app.get("/assistant/stream/:sid", assistantRoutes.streamHandler);
app.use("/assistant", appAuth, perUserLimit, assistantRoutes);

// Onboarding survey + profile view (feeds users table + agent memory).
app.use("/profile", appAuth, require("./routes/profile"));

// Real-time human avatar (Tavus CVI) — hidden until TAVUS_* env is set.
app.use("/avatar", appAuth, require("./avatar/tavus"));


// Phase 1 / ADR-004 — the user-visible audit trail of assistant actions.
app.use("/actions", appAuth, require("./routes/actions"));

// Privacy dashboard (F2): full data export + permanent account deletion.
app.use("/privacy", appAuth, require("./routes/privacy"));

// Google account link: Gmail + Calendar (read-only).
app.use("/google", appAuth, require("./google/routes"));


// Reminders (voice-created via /chat intents + Today screen CRUD).
app.use("/reminders", appAuth, require("./reminders/routes"));

// ADMIN — read-only ops stats behind a static key (set ADMIN_KEY).
app.use("/admin", require("./routes/admin"));

// Live data for the Today screen (weather card, headlines).
const wxTool = require("./services/tools/weather");
const newsTool = require("./services/tools/news");
app.get("/tools/weather", appAuth, async (req, res) => {
  try {
    const w = await wxTool.getWeather({
      lat: parseFloat(req.query.lat),
      lng: parseFloat(req.query.lng),
      city: req.query.city,
    });
    if (!w) return res.status(400).json({ error: "lat/lng or city required" });
    res.json(w);
  } catch (e) {
    res.status(502).json({ error: "weather unavailable" });
  }
});
app.get("/tools/news", appAuth, async (req, res) => {
  try {
    res.json({ headlines: await newsTool.getHeadlines({ topic: req.query.topic }) });
  } catch (e) {
    res.status(502).json({ error: "news unavailable" });
  }
});

// Voice transcription (Gemini) — same auth as chat
app.use("/stt", appAuth, perUserLimit, sttRoute);

app.use("/tts", appAuth, perUserLimit, ttsRoute);

// Group B — photos, documents, OCR, screenshot helper (Gemini vision).
app.use("/vision", appAuth, perUserLimit, require("./routes/vision"));

// Group B+ — SAVED documents: hospital reports, receipts… Hari remembers
// them and pulls them back up from a voice request (see routes/docs.js).
app.use("/docs", appAuth, require("./routes/docs"));

// PROFESSIONAL MODE — per-client/patient case files (doctor, lawyer…):
// profile + dated notes + linked documents, recalled by voice
// ("pull up patient Ramesh's file"). See routes/clients.js.
app.use("/clients", appAuth, require("./routes/clients"));

// Group C — nearby places search (ratings, distance, call & directions).
app.use("/places", appAuth, require("./routes/places"));

// Regional language from the caller's IP (no app permissions needed)
app.use("/region", regionRoute);

// LIVE MODE (experimental): the probe route must register BEFORE the JSON
// 404 catch-all below, or /live would always 404; the WS upgrade handler is
// attached to the HTTP server after listen because it needs that handle.
const live = require("./live/proxy");
app.use("/live", live.probeRouter());

// JSON 404 for unmatched routes (instead of Express's default HTML page)
app.use((_req, res) => res.status(404).json({ error: "not found" }));

// Last-resort error handler — also catches malformed JSON bodies
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "internal error" });
});

const port = process.env.PORT || 3000;
// Postgres: create the schema BEFORE accepting any request — a request
// racing table creation would 500. Boot fails loudly if the DB is down,
// which is exactly what Kubernetes needs to restart/backoff the pod.
require("./db")
  .init()
  .then(() => {
    const server = app.listen(port, () => {
      console.log(`MYASSISTANT backend on :${port} (postgres ready)`);
      // A key defined TWICE in .env silently keeps the LAST value, which is
      // a brutal way to lose an afternoon: the file looks right at a glance
      // but the app runs the other value. Call it out loudly at boot.
      try {
        const fs = require("fs");
        const path = require("path");
        const envPath = path.resolve(process.cwd(), ".env");
        if (fs.existsSync(envPath)) {
          const seen = new Map();
          for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
            const m = /^\s*([A-Z0-9_]+)\s*=/i.exec(line);
            if (m) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
          }
          const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
          if (dupes.length) {
            console.error(
              `  WARNING: .env defines these keys more than once — the LAST ` +
                `value wins: ${dupes.join(", ")}`
            );
          }
        }
      } catch (_) {}
      // Print the models actually in use. A wrong/retired name otherwise
      // only shows up as a 404 on the user's first voice turn, which reads
      // like "the app can't hear me" rather than a config problem.
      console.log(
        `  models: chat=${process.env.GEMINI_MODEL || "gemini-2.5-flash"}` +
          ` stt=${process.env.GEMINI_STT_MODEL || "(same as chat)"}` +
          ` vision=${process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash"}` +
          ` tts=${process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts"}` +
          ` thinking=${process.env.GEMINI_THINKING_LEVEL || "low"}`
      );
      if (!process.env.GEMINI_API_KEY) {
        console.warn(
          "WARNING: GEMINI_API_KEY not set — /vision and /docs analysis " +
            "(Group B: photos, PDFs, OCR, screenshots) will return 503. " +
            "Chat and voice will NOT work without it."
        );
      }
    });
    // LIVE MODE: attach the /live/ws upgrade handler to the running server.
    live.attachWs(server);
    console.log(
      `  live mode: model=${process.env.GEMINI_LIVE_MODEL || "gemini-2.5-flash-native-audio-preview"} at /live/ws (experimental)`
    );
  })
  .catch((e) => {
    console.error("FATAL: could not initialize Postgres:", e.message);
    process.exit(1);
  });
