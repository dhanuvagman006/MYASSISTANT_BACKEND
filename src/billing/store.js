/**
 * BILLING STORE (Postgres) — subscriptions, usage metering, families.
 *
 * Design notes:
 *  • Usage rows are (user, kind, period) counters — one UPSERT per event.
 *    Periods: "D:2026-07-29" (daily) and "M:2026-07" (monthly).
 *  • A user's EFFECTIVE plan: own active subscription → that plan; else
 *    member of a family whose owner has an active family sub → family;
 *    else free. Expiry is checked on read — no cron needed.
 *  • Payments are recorded idempotently by payment id (webhooks retry).
 * Schema lives in src/db.js init().
 */
const crypto = require("crypto");
const { query, one, run } = require("../db");
const { PLANS, PERIOD_DAYS } = require("./plans");

// ---------------- periods ----------------

function dayPeriod(now = new Date()) {
  return "D:" + now.toISOString().slice(0, 10);
}
function monthPeriod(now = new Date()) {
  return "M:" + now.toISOString().slice(0, 7);
}
const periodFor = (kind) => (kind === "agent_min" ? monthPeriod() : dayPeriod());

// ---------------- small helpers ----------------

const subGet = (userId) =>
  one("SELECT * FROM subscriptions WHERE user_id = $1", [String(userId)]);
const famByOwner = (ownerId) =>
  one("SELECT * FROM families WHERE owner_id = $1", [String(ownerId)]);
const famByCode = (code) => one("SELECT * FROM families WHERE code = $1", [code]);
const memberOf = (userId) =>
  one("SELECT * FROM family_members WHERE user_id = $1", [String(userId)]);

// ---------------- plan resolution ----------------

/** Own active sub, family-derived plan, or free. */
async function effectivePlan(userId) {
  const now = Date.now();
  const own = await subGet(userId);
  if (own && own.period_end > now) return { plan: own.plan, sub: own, via: "own" };
  const membership = await memberOf(userId);
  if (membership) {
    const fam = await one("SELECT * FROM families WHERE id = $1", [membership.family_id]);
    if (fam) {
      const ownerSub = await subGet(fam.owner_id);
      if (ownerSub && ownerSub.plan === "family" && ownerSub.period_end > now) {
        return { plan: "family", sub: ownerSub, via: "family", familyId: fam.id };
      }
    }
  }
  return { plan: "free", sub: null, via: "none" };
}

async function activate({ userId, plan, paymentId, amount }) {
  // Idempotent: the same webhook may be delivered more than once.
  if (paymentId) {
    const seen = await one("SELECT 1 FROM payments WHERE payment_id = $1", [paymentId]);
    if (seen) return subGet(userId);
  }
  const now = Date.now();
  const existing = await subGet(userId);
  // Renewals extend from the current expiry, not from today.
  const base = existing && existing.period_end > now ? existing.period_end : now;
  await run(
    `INSERT INTO subscriptions (user_id, plan, period_end, last_payment, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       plan = EXCLUDED.plan, period_end = EXCLUDED.period_end,
       last_payment = EXCLUDED.last_payment, updated_at = EXCLUDED.updated_at`,
    [String(userId), plan, base + PERIOD_DAYS * 24 * 3600 * 1000, paymentId || null, now]
  );
  if (paymentId) {
    await run(
      `INSERT INTO payments (payment_id, user_id, plan, amount, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (payment_id) DO NOTHING`,
      [paymentId, String(userId), plan, amount || 0, now]
    );
  }
  return subGet(userId);
}

// ---------------- usage ----------------

async function bump(userId, kind, by = 1) {
  await run(
    `INSERT INTO usage (user_id, kind, period, count) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, kind, period) DO UPDATE SET count = usage.count + EXCLUDED.count`,
    [String(userId), kind, periodFor(kind), by]
  );
}

async function used(userId, kind) {
  const row = await one(
    "SELECT count FROM usage WHERE user_id = $1 AND kind = $2 AND period = $3",
    [String(userId), kind, periodFor(kind)]
  );
  return row ? row.count : 0;
}

/** Family-pooled usage (agent minutes) — sums every member incl. owner. */
async function usedPooled(familyId, kind) {
  const row = await one(
    `SELECT COALESCE(SUM(count), 0)::int AS total FROM usage
     WHERE kind = $1 AND period = $2 AND user_id IN
       (SELECT user_id FROM family_members WHERE family_id = $3
        UNION SELECT owner_id FROM families WHERE id = $3)`,
    [kind, periodFor(kind), familyId]
  );
  return row ? row.total : 0;
}

/**
 * Remaining allowance for [kind]; Infinity when unlimited.
 * Family agent minutes draw from the shared pool.
 */
async function remaining(userId, kind) {
  const eff = await effectivePlan(userId);
  const limits = PLANS[eff.plan];
  const limitKey = {
    chat: "chatPerDay",
    stt: "sttPerDay",
    vision: "visionPerDay",
    agent_min: "agentMinutesPerMonth",
  }[kind];
  const limit = limits[limitKey];
  if (limit < 0) return { left: Infinity, limit: -1, plan: eff.plan };
  let consumed;
  if (kind === "agent_min" && eff.plan === "family") {
    // The pool covers the OWNER too, not just joined members.
    let famId = eff.familyId;
    if (!famId) famId = (await famByOwner(userId))?.id;
    consumed = famId ? await usedPooled(famId, kind) : await used(userId, kind);
  } else {
    consumed = await used(userId, kind);
  }
  return { left: Math.max(0, limit - consumed), limit, plan: eff.plan };
}

// ---------------- families ----------------

async function createOrGetFamily(ownerId) {
  let fam = await famByOwner(ownerId);
  if (fam) return fam;
  // Unambiguous invite code (no 0/O/1/I lookalikes).
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join("");
  } while (await famByCode(code));
  await run("INSERT INTO families (owner_id, code, created_at) VALUES ($1, $2, $3)", [
    String(ownerId), code, Date.now(),
  ]);
  return famByOwner(ownerId);
}

async function joinFamily(userId, code) {
  const fam = await famByCode(String(code).toUpperCase().trim());
  if (!fam) return { error: "invalid code" };
  if (fam.owner_id === String(userId)) return { error: "you own this family" };
  const ownerSub = await subGet(fam.owner_id);
  if (!ownerSub || ownerSub.plan !== "family" || ownerSub.period_end < Date.now()) {
    return { error: "this family plan is not active" };
  }
  const seats = PLANS.family.familySeats;
  const count =
    (await one("SELECT COUNT(*)::int AS n FROM family_members WHERE family_id = $1", [fam.id])).n + 1; // +1 = the owner
  if (count >= seats) return { error: "family is full" };
  await run("DELETE FROM family_members WHERE user_id = $1", [String(userId)]); // moving families: leave the old one
  await run(
    `INSERT INTO family_members (family_id, user_id, joined_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [fam.id, String(userId), Date.now()]
  );
  return { family: fam };
}

async function leaveFamily(userId) {
  await run("DELETE FROM family_members WHERE user_id = $1", [String(userId)]);
}

async function familyInfo(userId) {
  const owned = await famByOwner(userId);
  if (owned) {
    const members = await query(
      "SELECT user_id, joined_at FROM family_members WHERE family_id = $1",
      [owned.id]
    );
    return {
      role: "owner",
      code: owned.code,
      members: members.length + 1,
      seats: PLANS.family.familySeats,
    };
  }
  const m = await memberOf(userId);
  if (m) return { role: "member" };
  return null;
}

// ---------------- admin stats ----------------

async function stats() {
  const subs = {};
  for (const r of await query(
    "SELECT plan, COUNT(*)::int AS n FROM subscriptions WHERE period_end > $1 GROUP BY plan",
    [Date.now()]
  )) subs[r.plan] = r.n;
  const usageToday = {};
  for (const r of await query(
    "SELECT kind, SUM(count)::int AS total FROM usage WHERE period = $1 GROUP BY kind",
    [dayPeriod()]
  )) usageToday[r.kind] = r.total;
  const agentMonth = await query(
    "SELECT kind, SUM(count)::int AS total FROM usage WHERE period = $1 GROUP BY kind",
    [monthPeriod()]
  );
  for (const r of agentMonth) if (r.kind === "agent_min") usageToday.agent_min_month = r.total;
  return {
    users: (await one("SELECT COUNT(*)::int AS n FROM users")).n,
    activeSubscriptions: subs,
    usageToday,
  };
}

module.exports = {
  effectivePlan,
  activate,
  bump,
  used,
  remaining,
  createOrGetFamily,
  joinFamily,
  leaveFamily,
  familyInfo,
  stats,
};
