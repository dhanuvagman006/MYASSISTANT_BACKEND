/**
 * GMAIL + CALENDAR (read-only) helpers, used by /google routes and the
 * /chat intent layer. Everything returns plain JS objects the app and
 * the AI can both consume.
 */
const tokens = require("./tokens");

const TIMEOUT = 10_000;

async function gget(userId, url) {
  const at = await tokens.accessToken(userId);
  if (!at) return null;
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${at}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error(`google api ${r.status}`);
  return r.json();
}

function header(msg, name) {
  return (
    msg.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase()
    )?.value || ""
  );
}

/** "Ramesh Kumar <x@y.com>" → "Ramesh Kumar" */
function fromName(v) {
  const m = v.match(/^"?([^"<]+)"?\s*</);
  return (m ? m[1] : v).trim();
}

/**
 * Recent primary-inbox emails.
 * @returns null when Gmail isn't linked; else
 *   [{ id, from, subject, snippet, unread, date }]
 */
async function recentEmails(userId, { max = 10 } = {}) {
  const list = await gget(
    userId,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages" +
      `?maxResults=${max}&q=${encodeURIComponent("in:inbox category:primary newer_than:3d")}`
  );
  if (list === null) return null;
  const ids = (list.messages || []).map((m) => m.id);

  const msgs = await Promise.all(
    ids.map((id) =>
      gget(
        userId,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
          "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date"
      ).catch(() => null)
    )
  );

  return msgs
    .filter(Boolean)
    .map((m) => ({
      id: m.id,
      from: fromName(header(m, "From")),
      subject: header(m, "Subject") || "(no subject)",
      snippet: (m.snippet || "").slice(0, 160),
      unread: (m.labelIds || []).includes("UNREAD"),
      date: Number(m.internalDate) || null,
    }));
}

/**
 * Calendar events for the next [days].
 * @returns null when not linked; else [{ id, title, start, end, allDay, location }]
 */
async function upcomingEvents(userId, { days = 7, max = 15 } = {}) {
  const now = new Date();
  const j = await gget(
    userId,
    "https://www.googleapis.com/calendar/v3/calendars/primary/events" +
      `?singleEvents=true&orderBy=startTime&maxResults=${max}` +
      `&timeMin=${encodeURIComponent(now.toISOString())}` +
      `&timeMax=${encodeURIComponent(new Date(now.getTime() + days * 864e5).toISOString())}`
  );
  if (j === null) return null;
  return (j.items || []).map((e) => ({
    id: e.id,
    title: e.summary || "(untitled)",
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
    allDay: !e.start?.dateTime,
    location: e.location || "",
  }));
}

// ---------- plain-text renderings for the AI context ----------

function describeEmails(emails) {
  if (!emails || emails.length === 0) return "";
  const unread = emails.filter((e) => e.unread);
  const pick = (unread.length > 0 ? unread : emails).slice(0, 6);
  return (
    `Inbox (${unread.length} unread of ${emails.length} recent):\n` +
    pick
      .map(
        (e, i) =>
          `${i + 1}. ${e.unread ? "[UNREAD] " : ""}From ${e.from}: "${e.subject}" — ${e.snippet}`
      )
      .join("\n")
  );
}

function describeEvents(events, tzOffsetMin) {
  if (!events || events.length === 0) return "";
  const fmt = (iso) => {
    if (!iso) return "?";
    if (!iso.includes("T")) return iso; // all-day date
    const d = new Date(new Date(iso).getTime() + tzOffsetMin * 60_000);
    return d.toISOString().replace("T", " ").slice(0, 16);
  };
  return (
    "Upcoming calendar events (times in the user's local time):\n" +
    events
      .slice(0, 8)
      .map(
        (e) =>
          `- ${e.title}${e.allDay ? " (all day " + e.start + ")" : ` at ${fmt(e.start)}`}` +
          (e.location ? ` @ ${e.location}` : "")
      )
      .join("\n")
  );
}

module.exports = { recentEmails, upcomingEvents, describeEmails, describeEvents };
