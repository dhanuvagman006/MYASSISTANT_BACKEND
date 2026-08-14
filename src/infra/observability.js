/**
 * OBSERVABILITY (§26) — structured logs, request IDs, latency.
 *
 * Every log line is JSON with a correlation id, so one voice turn can be
 * followed across HTTP → agent → tool → MCP → database.
 *
 * §26 also says not to log sensitive user content: `redact()` strips
 * anything credential-shaped and truncates free text, so a tool's
 * arguments can be logged for debugging without leaking what the user
 * actually said or their tokens.
 */
const crypto = require("crypto");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] || 20;

/** Rolling in-memory metrics; exposed via /metrics for scraping. */
const METRICS = {
  started: Date.now(),
  counters: Object.create(null),
  latency: Object.create(null), // name -> {n, sum, max}
};

function count(name, n = 1) {
  METRICS.counters[name] = (METRICS.counters[name] || 0) + n;
}

function observe(name, ms) {
  const m = METRICS.latency[name] || (METRICS.latency[name] = { n: 0, sum: 0, max: 0 });
  m.n++;
  m.sum += ms;
  if (ms > m.max) m.max = ms;
}

function snapshot() {
  const lat = {};
  for (const [k, v] of Object.entries(METRICS.latency)) {
    lat[k] = { count: v.n, avgMs: Math.round(v.sum / v.n), maxMs: Math.round(v.max) };
  }
  return {
    uptimeMs: Date.now() - METRICS.started,
    counters: { ...METRICS.counters },
    latency: lat,
  };
}

const SENSITIVE = /token|secret|key|password|authorization|credential|cookie/i;

/** Removes credentials and truncates user content before logging. */
function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 120 ? value.slice(0, 120) + "…" : value;
  }
  if (typeof value !== "object" || depth > 3) return value;
  if (Array.isArray(value)) return value.slice(0, 5).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function log(level, event, fields = {}) {
  if ((LEVELS[level] || 20) < MIN) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(fields),
  };
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  out(JSON.stringify(line));
}

const logger = {
  debug: (e, f) => log("debug", e, f),
  info: (e, f) => log("info", e, f),
  warn: (e, f) => log("warn", e, f),
  error: (e, f) => log("error", e, f),
};

/**
 * Express middleware: assigns/propagates a request id and records latency.
 * Health and metrics are not logged — they would drown the signal.
 */
function requestId() {
  return (req, res, next) => {
    const id = req.headers["x-request-id"] || crypto.randomBytes(8).toString("hex");
    req.requestId = String(id);
    res.setHeader("x-request-id", req.requestId);
    if (req.path === "/health" || req.path === "/metrics") return next();

    const t0 = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - t0;
      observe(`http ${req.method} ${req.route?.path || req.path.split("/")[1] || "/"}`, ms);
      count(`http.${res.statusCode >= 500 ? "5xx" : res.statusCode >= 400 ? "4xx" : "ok"}`);
      logger.info("http", {
        rid: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms,
        // user id only — never the body
        uid: req.user?.sub ?? null,
      });
    });
    next();
  };
}

/** Times an async operation and records it under `name`. */
async function timed(name, fn, fields = {}) {
  const t0 = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - t0;
    observe(name, ms);
    count(`${name}.ok`);
    logger.debug("op", { op: name, ms, ...fields });
    return out;
  } catch (e) {
    const ms = Date.now() - t0;
    observe(name, ms);
    count(`${name}.error`);
    logger.error("op_failed", { op: name, ms, error: e.message, ...fields });
    throw e;
  }
}

module.exports = { logger, requestId, timed, count, observe, snapshot, redact, METRICS };
