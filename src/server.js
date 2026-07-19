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
app.use(express.json({ limit: "2mb" }));

// Basic abuse protection: 60 requests/minute per IP
app.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true }));

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Public within the app: remote config (no secrets inside it)
app.use("/config", configRoute);

// Sign-up/sign-in — extra-tight limit to slow brute-force attempts
app.use(
  "/auth",
  rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true }),
  authRoute
);

// Chat requires the app key so strangers can't burn your AI credits
app.use("/chat", appAuth, chatRoute);

// Voice transcription (Whisper via Groq) — same auth as chat
app.use("/stt", appAuth, sttRoute);

// Regional language from the caller's IP (no app permissions needed)
app.use("/region", regionRoute);

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
app.listen(port, () => console.log(`MYASSISTANT backend on :${port}`));
