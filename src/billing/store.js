/**
 * BILLING STORE — subscriptions, usage metering, families.
 *
 * Design notes:
 *  • Usage rows are (user, kind, period) counters — one UPSERT per event,
 *    no per-event rows, so the table stays tiny at any scale and reads
 *    are O(1). Periods: "D:2026-07-29" (daily) and "M:2026-07" (monthly).
 *  • A user's EFFECTIVE plan: own active subscription → that plan; else
 *    member of a family whose owner has an active family sub → family;
 *    else free. Expiry is checked on read — no cron needed.
 *  • Payments are recorded idempotently by payment id (webhooks retry).
 */
const crypto = require("crypto");
const { db } = require("../db");
const { PLANS, PERIOD_DAYS } = require("./plans");

db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id        TEXT PRIMARY KEY,
    plan           TEXT NOT NULL,             -- pro | family
    period_end     INTEGER NOT NULL,          -- ms epoch; active while now < this
    last_payment   TEXT,                      -- razorpay payment id (idempotency)
    updated_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage (
    user_id   TEXT NOT NULL,
    kind      TEXT NOT NULL,                  -- chat | stt | vision | agent_min
    period    TEXT NOT NULL,                  -- D:YYYY-MM-DD | M:YYYY-MM
    count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, kind, period)
  );
  CREATE TABLE IF NOT EXISTS families (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   TEXT NOT NULL UNIQUE,
    code       TEXT NOT NULL UNIQUE,          -- invite code
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS family_members (
    family_id  INTEGER NOT NULL,
    user_id    TEXT NOT NULL UNIQUE,          -- one family per user
    joined_at  INTEGER NOT NULL,
    PRIMARY KEY (family_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS payments (
    payment_id TEXT PRIMARY KEY,              -- razorpay id (idempotency)
    user_id    TEXT NOT NULL,
    plan       TEXT NOT NULL,
    amount     INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const stmts = {
  subGet: db.prepare("SELECT * FROM subscriptions WHERE user_id = ?"),
  subUpsert: db.prepare(`
    INSERT INTO subscriptions (user_id, plan, period_end, last_payment, updated_at)
    VALUES (@user_id, @plan, @period_end, @last_payment, @now)
    ON CONFLICT(user_id) DO UPDATE SET
      plan = @plan, period_end = @period_end,
      last_payment = @last_payment, updated_at = @now
  `),
  usageBump: db.prepare(`
    INSERT INTO usage (user_id, kind, period, count) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, kind, period) DO UPDATE SET count = count + excluded.count
  `),
  usageGet: db.prepare(
    "SELECT count FROM usage WHERE user_id = ? AND kind = ? AND period = ?"
  ),
  usageSum: db.prepare(`
    SELECT COALESCE(SUM(count), 0) AS total FROM usage
    WHERE kind = ? AND period = ? AND user_id IN
      (SELECT user_id FROM family_members WHERE family_id = ?
       UNION SELECT owner_id FROM families WHERE id = ?)
  `),
  famByOwner: db.prepare("SELECT * FROM families WHERE owner_id = ?"),
  famByCode: db.prepare("SELECT * FROM families WHERE code = ?"),
  famById: db.prepare("SELECT * FROM families WHERE id = ?"),
  famInsert: db.prepare(
    "INSERT INTO families (owner_id, code, created_at) VALUES (?, ?, ?)"
  ),
  memberOf: db.prepare("SELECT * FROM family_members WHERE user_id = ?"),
  memberCount: db.prepare(
    "SELECT COUNT(*) AS n FROM family_members WHERE family_id = ?"
  ),
  memberAdd: db.prepare(
    "INSERT OR IGNORE INTO family_members (family_id, user_id, joined_at) VALUES (?, ?, ?)"
  ),
  memberDel: db.prepare("DELETE FROM family_members WHERE user_id = ?"),
  membersList: db.prepare(
    "SELECT user_id, joined_at FROM family_members WHERE family_id = ?"
  ),
  payGet: db.prepare("SELECT * FROM payments WHERE payment_id = ?"),
  payAdd: db.prepare(`
    INSERT OR IGNORE INTO payments (payment_id, user_id, plan, amount, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  statUsers: db.prepare("SELECT COUNT(*) AS n FROM users"),
  statSubs: db.prepare(
    "SELECT plan, COUNT(*) AS n FROM subscriptions WHERE period_end > ? GROUP BY plan"
  ),
  statUsageToday: db.prepare(
    "SELECT kind, SUM(count) AS total FROM usage WHERE period = ? GROUP BY kind"
  ),
};

// ---------------- periods ----------------

function dayPeriod(now = new Date()) {
  return "D:" + now.toISOString().slice(0, 10);
}
function monthPeriod(now = new Date()) {
  return "M:" + now.toISOString().slice(0, 7);
}
const periodFor = (kind) => (kind === "agent_min" ? monthPeriod() : dayPeriod());

// ---------------- plan resolution ----------------

/** Own active sub, family-derived plan, or free. */
function effectivePlan(userId) {
  const now = Date.now();
  const own = stmts.subGet.get(String(userId));
  if (own && own.period_end > now) return { plan: own.plan, sub: own, via: "own" };
  const membership = stmts.memberOf.get(String(userId));
  if (membership) {
    const fam = stmts.famById.get(membership.family_id);
    if (fam) {
      const ownerSub = stmts.subGet.get(fam.owner_id);
      if (ownerSub && ownerSub.plan === "family" && ownerSub.period_end > now) {
        return { plan: "family", sub: ownerSub, via: "family", familyId: fam.id };
      }
    }
  }
  return { plan: "free", sub: null, via: "none" };
}

function activate({ userId, plan, paymentId, amount }) {
  // Idempotent: the same webhook may be delivered more than once.
  if (paymentId && stmts.payGet.get(paymentId)) return stmts.subGet.get(String(userId));
  const now = Date.now();
  const existing = stmts.subGet.get(String(userId));
  // Renewals extend from the current expiry, not from today.
  const base = existing && existing.period_end > now ? existing.period_end : now;
  stmts.subUpsert.run({
    user_id: String(userId),
    plan,
    period_end: base + PERIOD_DAYS * 24 * 3600 * 1000,
    last_payment: paymentId || null,
    now,
  });
  if (paymentId) stmts.payAdd.run(paymentId, String(userId), plan, amount || 0, now);
  return stmts.subGet.get(String(userId));
}

// ---------------- usage ----------------

function bump(userId, kind, by = 1) {
  stmts.usageBump.run(String(userId), kind, periodFor(kind), by);
}

function used(userId, kind) {
  const row = stmts.usageGet.get(String(userId), kind, periodFor(kind));
  return row ? row.count : 0;
}

/** Family-pooled usage (agent minutes) — sums every member incl. owner. */
function usedPooled(familyId, kind) {
  const row = stmts.usageSum.get(kind, periodFor(kind), familyId, familyId);
  return row ? row.total : 0;
}

/**
 * Remaining allowance for [kind]; Infinity when unlimited.
 * Family agent minutes draw from the shared pool.
 */
function remaining(userId, kind) {
  const eff = effectivePlan(userId);
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
    if (!famId) famId = stmts.famByOwner.get(String(userId))?.id;
    consumed = famId ? usedPooled(famId, kind) : used(userId, kind);
  } else {
    consumed = used(userId, kind);
  }
  return { left: Math.max(0, limit - consumed), limit, plan: eff.plan };
}

// ---------------- families ----------------

function createOrGetFamily(ownerId) {
  let fam = stmts.famByOwner.get(String(ownerId));
  if (fam) return fam;
  // Unambiguous invite code (no 0/O/1/I lookalikes).
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join("");
  } while (stmts.famByCode.get(code));
  stmts.famInsert.run(String(ownerId), code, Date.now());
  return stmts.famByOwner.get(String(ownerId));
}

function joinFamily(userId, code) {
  const fam = stmts.famByCode.get(String(code).toUpperCase().trim());
  if (!fam) return { error: "invalid code" };
  if (fam.owner_id === String(userId)) return { error: "you own this family" };
  const ownerSub = stmts.subGet.get(fam.owner_id);
  if (!ownerSub || ownerSub.plan !== "family" || ownerSub.period_end < Date.now()) {
    return { error: "this family plan is not active" };
  }
  const seats = PLANS.family.familySeats;
  const count = stmts.memberCount.get(fam.id).n + 1; // +1 = the owner
  if (count >= seats) return { error: "family is full" };
  stmts.memberDel.run(String(userId)); // moving families: leave the old one
  stmts.memberAdd.run(fam.id, String(userId), Date.now());
  return { family: fam };
}

function leaveFamily(userId) {
  stmts.memberDel.run(String(userId));
}

function familyInfo(userId) {
  const owned = stmts.famByOwner.get(String(userId));
  if (owned) {
    return {
      role: "owner",
      code: owned.code,
      members: stmts.membersList.all(owned.id).length + 1,
      seats: PLANS.family.familySeats,
    };
  }
  const m = stmts.memberOf.get(String(userId));
  if (m) return { role: "member" };
  return null;
}

// ---------------- admin stats ----------------

function stats() {
  const subs = {};
  for (const r of stmts.statSubs.all(Date.now())) subs[r.plan] = r.n;
  const usageToday = {};
  for (const r of stmts.statUsageToday.all(dayPeriod())) usageToday[r.kind] = r.total;
  const agentMonth = stmts.statUsageToday.all(monthPeriod());
  for (const r of agentMonth) if (r.kind === "agent_min") usageToday.agent_min_month = r.total;
  return {
    users: stmts.statUsers.get().n,
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
