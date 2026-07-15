require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const configRoute = require("./routes/config");
const chatRoute = require("./routes/chat");
const { appAuth } = require("./middleware/auth");

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "2mb" }));

// Basic abuse protection: 60 requests/minute per IP
app.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true }));

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Public within the app: remote config (no secrets inside it)
app.use("/config", configRoute);

// Chat requires the app key so strangers can't burn your AI credits
app.use("/chat", appAuth, chatRoute);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MYASSISTANT backend on :${port}`));
