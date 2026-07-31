/**
 * BILLING — plan status, checkout, Razorpay webhook, families, and the
 * ENFORCEMENT middleware that meters and caps AI/telephony usage.
 *
 * App-facing (behind appAuth):
 *   GET  /billing                → plan, expiry, usage/limits, family info
 *   POST /billing/checkout       {plan} → {url} (Razorpay hosted page)
 *   POST /billing/family/invite  → {code} (family-plan owners only)
 *   POST /billing/family/join    {code}
 *   POST /billing/family/leave
 *
 * Razorpay-facing (NO app JWT — verified by X-Razorpay-Signature):
 *   POST /billing/webhook
 *
 * Enforcement (exported, used in server.js):
 *   enforce("chat" | "stt" | "vision")  → 402 {code:"limit_reached"} when
 *   the day's allowance is exhausted; otherwise meters 1 and continues.
 *   Dev sessions (AUTH_DISABLED / X-App-Key) are never limited.
 */
const express = require("express");
const store = require("./store");
const razorpay = require("./razorpay");
const { PLANS, isPaidPlan } = require("./plans");

const router = express.Router();

/** Dev/API-key pseudo-users can't pay — exempt them from limits. */
const isDevUser = (sub) => !/^\d+$/.test(String(sub || ""));

// ---------------- enforcement middleware ----------------

function enforce(kind) {
  return async (req, res, next) => {
    const sub = req.user?.sub;
    if (isDevUser(sub)) return next();
    // Greeting rides on /chat but is one short call on app-open — free.
    if (kind === "chat" && req.path === "/greeting") return next();
    const { left, limit, plan } = await store.remaining(sub, kind);
    if (left <= 0) {
      return res.status(402).json({
        error:
          plan === "free"
            ? "You've used today's free allowance. Upgrade to Pro for unlimited access."
            : "You've reached this plan's limit for now.",
        code: "limit_reached",
        kind,
        limit,
        plan,
      });
    }
    await store.bump(sub, kind, 1);
    next();
  };
}

/** Agent calls are gated on REMAINING MINUTES (pooled for families);
 *  actual consumption is metered from real call duration on hangup. */
async function enforceAgentCall(req, res, next) {
  const sub = req.user?.sub;
  if (isDevUser(sub)) return next();
  const { left, plan } = await store.remaining(sub, "agent_min");
  if (left <= 0) {
    return res.status(402).json({
      error:
        plan === "free"
          ? "Agent calls are a Pro feature — upgrade to let Hari make calls for you."
          : "This month's agent-call minutes are used up.",
      code: "limit_reached",
      kind: "agent_min",
      plan,
    });
  }
  next();
}

/** Called from the agent-call hangup webhook with the billed seconds. */
function meterAgentSeconds(userId, seconds) {
  if (isDevUser(userId)) return;
  const mins = Math.max(1, Math.ceil((Number(seconds) || 0) / 60));
  store.bump(userId, "agent_min", mins).catch((e) => console.error("meter:", e.message));
}

/** Plan-based document cap, enforced at upload time. */
function enforceDocUpload(currentCount) {
  return async (req, res, next) => {
    const sub = req.user?.sub;
    if (isDevUser(sub)) return next();
    const { plan } = await store.effectivePlan(sub);
    const max = PLANS[plan].docsMax;
    let n = 0;
    try {
      n = await currentCount(sub);
    } catch (_) {}
    if (n >= max) {
      return res.status(402).json({
        error:
          plan === "free"
            ? `Free saves up to ${max} documents. Upgrade to keep up to ${PLANS.pro.docsMax}.`
            : "Document limit reached — delete one to save another.",
        code: "limit_reached",
        kind: "docs",
        plan,
      });
    }
    next();
  };
}

// ---------------- app-facing routes ----------------

router.get("/", async (req, res) => {
  const sub = req.user.sub;
  const eff = await store.effectivePlan(sub);
  const usage = {};
  for (const kind of ["chat", "stt", "vision", "agent_min"]) {
    const r = await store.remaining(sub, kind);
    usage[kind] = { limit: r.limit, left: r.left === Infinity ? -1 : r.left };
  }
  res.json({
    plan: eff.plan,
    via: eff.via,
    periodEnd: eff.sub ? eff.sub.period_end : null,
    prices: {
      pro: PLANS.pro.pricePaise,
      family: PLANS.family.pricePaise,
    },
    usage,
    family: await store.familyInfo(sub),
    paymentsConfigured: razorpay.configured(),
  });
});

router.post("/checkout", async (req, res) => {
  const sub = req.user.sub;
  if (isDevUser(sub)) {
    return res.status(400).json({ error: "sign in with a real account to upgrade" });
  }
  const plan = String(req.body?.plan || "");
  if (!isPaidPlan(plan)) return res.status(400).json({ error: "plan must be pro or family" });
  if (!razorpay.configured()) {
    return res.status(503).json({ error: "payments not configured on this server" });
  }
  try {
    const link = await razorpay.createPaymentLink({
      userId: sub,
      plan,
      amountPaise: PLANS[plan].pricePaise,
      description: `MYASSISTANT ${PLANS[plan].name} — 31 days`,
    });
    res.json({ url: link.short_url });
  } catch (e) {
    console.error("checkout failed:", e.message);
    res.status(502).json({ error: "could not start checkout" });
  }
});

// ---------------- Razorpay webhook ----------------

router.post("/webhook", async (req, res) => {
  if (!razorpay.validWebhook(req)) {
    return res.status(403).json({ error: "bad signature" });
  }
  const event = req.body?.event;
  if (event === "payment_link.paid") {
    const entity = req.body?.payload?.payment_link?.entity || {};
    const payment = req.body?.payload?.payment?.entity || {};
    const notes = entity.notes || {};
    const plan = String(notes.plan || "");
    const userId = String(notes.userId || "");
    if (isPaidPlan(plan) && /^\d+$/.test(userId)) {
      await store.activate({
        userId,
        plan,
        paymentId: payment.id || entity.id,
        amount: entity.amount,
      });
      console.log(`billing: user ${userId} → ${plan} (payment ${payment.id || "?"})`);
    }
  }
  // Always 200 fast — Razorpay retries non-2xx and we never want a
  // storm of duplicate deliveries (activation is idempotent anyway).
  res.json({ ok: true });
});

// ---------------- families ----------------

router.post("/family/invite", async (req, res) => {
  const sub = req.user.sub;
  const eff = await store.effectivePlan(sub);
  if (!(eff.plan === "family" && eff.via === "own")) {
    return res.status(402).json({
      error: "the Family plan is needed to invite members",
      code: "limit_reached",
    });
  }
  const fam = await store.createOrGetFamily(sub);
  res.json({ code: fam.code, seats: PLANS.family.familySeats });
});

router.post("/family/join", async (req, res) => {
  const out = await store.joinFamily(req.user.sub, req.body?.code || "");
  if (out.error) return res.status(400).json({ error: out.error });
  res.json({ ok: true, plan: "family" });
});

router.post("/family/leave", async (req, res) => {
  await store.leaveFamily(req.user.sub);
  res.json({ ok: true });
});

module.exports = { router, enforce, enforceAgentCall, meterAgentSeconds, enforceDocUpload };
