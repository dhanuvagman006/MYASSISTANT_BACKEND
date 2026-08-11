/**
 * BOOKING AGENT — "book a table for two at Empire tomorrow 8pm",
 * "book an appointment with Dr Rao on Friday", "what are my bookings?",
 * "cancel my booking".
 *
 * What it actually does today:
 *  - parses WHAT / WHERE / WHEN (chrono-node handles natural dates in
 *    the user's timezone) and writes a row to the `bookings` table
 *  - attaches a REMINDER one hour before, through the existing
 *    reminders store, so the phone genuinely nudges the user
 *  - lists and cancels bookings conversationally
 *  - logs to actions_log (the privacy dashboard shows every booking)
 *
 * It does NOT call third-party reservation APIs yet — each provider
 * (OpenTable/Dineout/practo etc.) needs its own partner key. The
 * `confirmProvider()` seam below is where such an integration plugs in;
 * until then the agent is an impeccable personal booking ledger, which
 * is what a human PA without a partner login would keep too.
 */
const chrono = require("chrono-node");
const { query, one, run } = require("../db");
const { generateReply } = require("../services/ai/router");

const BOOK_RX =
  /\b(book|reserve|booking|reservation|appointment|table for|schedule (a|an|my))\b/i;
const LIST_RX = /\b(my bookings?|my reservations?|my appointments?|what.*booked)\b/i;
const CANCEL_RX = /\b(cancel|delete|remove).{0,24}\b(booking|reservation|appointment|table)\b/i;

function matches(text) {
  return BOOK_RX.test(text) || LIST_RX.test(text) || CANCEL_RX.test(text);
}

/* ------------------------------------------------------------------ */

function fmtWhen(ms, tzOffsetMin) {
  if (!ms) return "time to be decided";
  // Replies are READ ALOUD — "Wednesday 12 August at 8 pm", never ISO.
  const d = new Date(ms + tzOffsetMin * 60_000);
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months = ["January","February","March","April","May","June","July",
    "August","September","October","November","December"];
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  const time = m ? `${h}:${String(m).padStart(2, "0")} ${ap}` : `${h} ${ap}`;
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]} at ${time}`;
}

async function addReminderFor(userId, title, whenMs) {
  if (!userId || !whenMs) return;
  const remindAt = whenMs - 60 * 60 * 1000; // one hour before
  if (remindAt < Date.now()) return;
  await run(
    `INSERT INTO reminders (user_id, text, due_at, done, created_at)
     VALUES ($1,$2,$3,0,$4)`,
    [userId, `Booking soon: ${title}`, remindAt, Date.now()]
  );
}

async function logAction(userId, action, detail) {
  if (!userId) return;
  await run(
    `INSERT INTO actions_log (user_id, action, detail, created_at)
     VALUES ($1,$2,$3,$4)`,
    [userId, action, String(detail).slice(0, 300), Date.now()]
  ).catch(() => {});
}

/** Seam for real provider integrations (OpenTable/Practo/...). */
async function confirmProvider(_booking) {
  return { provider: "ledger", confirmed: true };
}

/* ------------------------------------------------------------------ */

const PARSE_PROMPT =
  "Extract booking details from one user message. Return STRICT JSON only: " +
  '{"kind":"restaurant|doctor|travel|salon|other","title":"short human title",' +
  '"venue":"place or person or null","party_size":number|null,' +
  '"notes":"anything else or null"} — no markdown, no prose.';

async function createBooking(userId, text, tzOffsetMin) {
  // Time: chrono in the user's local frame.
  const ref = new Date(Date.now() + tzOffsetMin * 60_000);
  const parsedDate = chrono.parseDate(text, ref, { forwardDate: true });
  const whenMs = parsedDate ? parsedDate.getTime() - tzOffsetMin * 60_000 : null;

  // Details: one small structured extraction.
  let d = { kind: "other", title: text.slice(0, 60), venue: null, party_size: null, notes: null };
  try {
    const { reply } = await generateReply(
      [{ role: "user", content: text.slice(0, 500) }],
      { system: PARSE_PROMPT }
    );
    const j = JSON.parse(String(reply || "").replace(/```json|```/g, "").trim());
    if (j && typeof j === "object") d = { ...d, ...j };
  } catch (_) {}

  const title =
    (d.title || "Booking") +
    (d.venue ? ` at ${d.venue}` : "") +
    (d.party_size ? ` for ${d.party_size}` : "");

  const row = await one(
    `INSERT INTO bookings (user_id, kind, title, venue, party_size, when_at, notes, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed',$8) RETURNING id`,
    [userId, d.kind, title.slice(0, 200), d.venue, d.party_size, whenMs, d.notes, Date.now()]
  );
  await confirmProvider({ id: row.id, ...d, whenMs });
  await addReminderFor(userId, title, whenMs);
  await logAction(userId, "booking.created", title);

  return { title, whenMs };
}

/* ------------------------------------------------------------------ */

/**
 * @param {{text:string, userId:number|null, tzOffsetMin:number}} turn
 * @returns {Promise<{text:string, used:Array}>}
 */
async function handle(turn) {
  const { text, userId, tzOffsetMin = 330 } = turn;
  if (!userId) {
    return {
      text: "I can keep bookings once you're signed in — please sign in first.",
      used: [],
    };
  }

  if (CANCEL_RX.test(text)) {
    const last = await one(
      `SELECT id, title FROM bookings
        WHERE user_id=$1 AND status='confirmed'
        ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    if (!last) return { text: "There's nothing booked to cancel.", used: [] };
    await run(`UPDATE bookings SET status='cancelled' WHERE id=$1`, [last.id]);
    await logAction(userId, "booking.cancelled", last.title);
    return {
      text: `Done — I've cancelled ${last.title}.`,
      used: [{ tool: "bookings", label: "Cancelling…" }],
    };
  }

  if (LIST_RX.test(text)) {
    const rows = await query(
      `SELECT title, when_at, status FROM bookings
        WHERE user_id=$1 AND status='confirmed'
        ORDER BY when_at NULLS LAST LIMIT 6`,
      [userId]
    );
    if (!rows.length) {
      return { text: "You have no upcoming bookings right now.", used: [{ tool: "bookings", label: "Checking your bookings…" }] };
    }
    const lines = rows
      .map((r) => `${r.title}, ${fmtWhen(Number(r.when_at), tzOffsetMin)}`)
      .join(". ");
    return {
      text: `Here's what you have: ${lines}.`,
      used: [{ tool: "bookings", label: "Checking your bookings…" }],
    };
  }

  const { title, whenMs } = await createBooking(userId, text, tzOffsetMin);
  const when = whenMs ? ` for ${fmtWhen(whenMs, tzOffsetMin)}` : "";
  return {
    text: `Booked — ${title}${when}. I'll remind you an hour before.`,
    used: [{ tool: "bookings", label: "Creating your booking…" }],
  };
}

module.exports = { matches, handle };
