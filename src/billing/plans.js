/**
 * PLANS & ENTITLEMENTS — the single source of truth for what each tier
 * gets. Prices are in paise (Razorpay's unit). -1 = unlimited.
 *
 * free   — taste of everything, hard caps keep AI/telephony costs ~zero
 * pro    — individual power users
 * family — one payer, up to 5 accounts, pooled agent-call minutes
 *          (the "Hari for amma" plan — members get pro-level limits)
 */
const PLANS = {
  free: {
    name: "Free",
    pricePaise: 0,
    chatPerDay: 20,
    sttPerDay: 40,
    visionPerDay: 5,
    docsMax: 10,
    agentMinutesPerMonth: 0,
    familySeats: 1,
  },
  pro: {
    name: "Pro",
    pricePaise: 24900, // ₹249 / month
    chatPerDay: -1,
    sttPerDay: -1,
    visionPerDay: 50,
    docsMax: 100,
    agentMinutesPerMonth: 30,
    familySeats: 1,
  },
  family: {
    name: "Family",
    pricePaise: 49900, // ₹499 / month
    chatPerDay: -1,
    sttPerDay: -1,
    visionPerDay: 50,
    docsMax: 100,
    agentMinutesPerMonth: 60, // POOLED across all members
    familySeats: 5,
  },
};

/** Days of access one successful payment buys (payment-link model —
 *  no auto-debit mandate; the app nudges renewal near expiry). */
const PERIOD_DAYS = 31;

const isPaidPlan = (p) => p === "pro" || p === "family";

module.exports = { PLANS, PERIOD_DAYS, isPaidPlan };
