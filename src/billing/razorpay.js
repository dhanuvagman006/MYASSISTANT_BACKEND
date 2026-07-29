/**
 * RAZORPAY — payment links + webhook verification (SDK-free).
 *
 * Model: PAYMENT LINKS, not auto-debit subscriptions. One tap in the app
 * opens a Razorpay-hosted page (UPI/cards/netbanking); on success the
 * `payment_link.paid` webhook activates 31 days of the chosen plan.
 * No recurring mandate = no RBI e-mandate friction; the app nudges
 * renewal near expiry. Upgrade to Razorpay Subscriptions later if churn
 * data says auto-renew is worth the mandate UX.
 *
 * Env:
 *   RAZORPAY_KEY_ID          rzp_test_… / rzp_live_…
 *   RAZORPAY_KEY_SECRET      API secret (basic-auth password)
 *   RAZORPAY_WEBHOOK_SECRET  set when creating the webhook in the dashboard
 */
const crypto = require("crypto");

const keyId = () => process.env.RAZORPAY_KEY_ID || "";
const keySecret = () => process.env.RAZORPAY_KEY_SECRET || "";
const webhookSecret = () => process.env.RAZORPAY_WEBHOOK_SECRET || "";

function configured() {
  return Boolean(keyId() && keySecret() && webhookSecret());
}

/**
 * Creates a payment link for [plan]. userId+plan ride in `notes`
 * (returned verbatim in the webhook) — that's how payment maps to user.
 * @returns {Promise<{short_url: string, id: string}>}
 */
async function createPaymentLink({ userId, plan, amountPaise, description }) {
  const r = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: {
      authorization:
        "Basic " + Buffer.from(`${keyId()}:${keySecret()}`).toString("base64"),
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      description,
      notes: { userId: String(userId), plan },
      // The link dies in 30 min — stale links can't be paid at old prices.
      expire_by: Math.floor(Date.now() / 1000) + 30 * 60,
      notify: { sms: false, email: false },
      reminder_enable: false,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      `razorpay ${r.status}: ${data?.error?.description || "link failed"}`
    );
  }
  return { short_url: data.short_url, id: data.id };
}

/**
 * Webhook signature: X-Razorpay-Signature = HMAC-SHA256 of the RAW body
 * with the webhook secret (hex). MUST be computed on the exact bytes
 * received — server.js captures req.rawBody for this.
 */
function validWebhook(req) {
  const sig = req.get("X-Razorpay-Signature") || "";
  const raw = req.rawBody;
  if (!sig || !raw || !webhookSecret()) return false;
  const expected = crypto
    .createHmac("sha256", webhookSecret())
    .update(raw)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (_) {
    return false;
  }
}

module.exports = { configured, createPaymentLink, validWebhook };
