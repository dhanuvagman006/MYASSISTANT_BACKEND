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

// ---------- WRITE helpers (D2 drafts · D3 event creation) ----------
// Require the gmail.compose and calendar.events scopes — the app's
// linkGoogleData() must request them (documented in the app repo).

async function gsend(userId, url, method, body) {
  const tokens = require("./tokens");
  const at = await tokens.accessToken(userId);
  if (!at) return null;
  const r = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${at}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (r.status === 403) throw new Error("google scope missing (reconnect Google to grant it)");
  if (!r.ok) throw new Error(`google api ${r.status}`);
  return r.json();
}

/** RFC 2822 → base64url, the format Gmail's raw field wants. */
function rawEmail({ to, subject, body, inReplyTo }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  }
  const msg = lines.join("\r\n") + "\r\n\r\n" + body;
  return Buffer.from(msg, "utf8").toString("base64url");
}

/**
 * D2 — save a DRAFT in the user's Gmail (never sends; the user reviews
 * and taps Send inside Gmail themselves).
 * @returns null when Gmail isn't linked; else { id }
 */
async function createDraft(userId, { to, subject, body, threadId, inReplyTo }) {
  const payload = { message: { raw: rawEmail({ to, subject, body, inReplyTo }) } };
  if (threadId) payload.message.threadId = threadId;
  const j = await gsend(
    userId,
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    "POST",
    payload
  );
  return j === null ? null : { id: j.id };
}

/** Full metadata of one message — used to build a reply draft. */
async function messageMeta(userId, id) {
  const m = await gget(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
      "?format=metadata&metadataHeaders=From&metadataHeaders=Subject" +
      "&metadataHeaders=Message-ID&metadataHeaders=Reply-To"
  );
  if (!m) return null;
  const fromFull = header(m, "From");
  const emailM = fromFull.match(/<([^>]+)>/);
  return {
    id: m.id,
    threadId: m.threadId,
    from: fromName(fromFull),
    fromEmail: emailM ? emailM[1] : fromFull.trim(),
    replyTo: header(m, "Reply-To") || null,
    subject: header(m, "Subject") || "(no subject)",
    messageId: header(m, "Message-ID") || null,
    snippet: (m.snippet || "").slice(0, 400),
  };
}

/**
 * D3 — create a calendar event. start/end are epoch ms (UTC).
 * @returns null when not linked; else { id, htmlLink }
 */
async function createEvent(userId, { title, startMs, endMs, location, description }) {
  const j = await gsend(
    userId,
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    "POST",
    {
      summary: String(title || "Event").slice(0, 200),
      location: location ? String(location).slice(0, 200) : undefined,
      description: description ? String(description).slice(0, 1000) : undefined,
      start: { dateTime: new Date(startMs).toISOString() },
      end: { dateTime: new Date(endMs || startMs + 36e5).toISOString() },
    }
  );
  return j === null ? null : { id: j.id, htmlLink: j.htmlLink || "" };
}

/** D3 — edit (patch) or delete an event the user created. */
async function updateEvent(userId, eventId, patch) {
  return gsend(
    userId,
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    "PATCH",
    patch
  );
}

/**
 * D4 — MEETING PREP: the next event + recent emails from its attendees.
 * One events call + one search per (≤3) attendees, all in parallel.
 * @returns null when not linked; { event:null } when nothing upcoming.
 */
async function meetingPrep(userId) {
  const now = new Date();
  const j = await gget(
    userId,
    "https://www.googleapis.com/calendar/v3/calendars/primary/events" +
      "?singleEvents=true&orderBy=startTime&maxResults=5" +
      `&timeMin=${encodeURIComponent(now.toISOString())}` +
      `&timeMax=${encodeURIComponent(new Date(now.getTime() + 2 * 864e5).toISOString())}`
  );
  if (j === null) return null;
  const ev = (j.items || []).find((e) => e.start?.dateTime); // skip all-day
  if (!ev) return { event: null, emails: [] };

  const attendees = (ev.attendees || [])
    .filter((a) => !a.self && a.email)
    .slice(0, 3);

  const emailLists = await Promise.all(
    attendees.map((a) =>
      gget(
        userId,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages" +
          `?maxResults=3&q=${encodeURIComponent(`from:${a.email} newer_than:14d`)}`
      )
        .then(async (list) => {
          const ids = (list?.messages || []).slice(0, 2).map((m) => m.id);
          const metas = await Promise.all(
            ids.map((id) => messageMeta(userId, id).catch(() => null))
          );
          return metas.filter(Boolean);
        })
        .catch(() => [])
    )
  );

  return {
    event: {
      id: ev.id,
      title: ev.summary || "(untitled)",
      start: ev.start.dateTime,
      end: ev.end?.dateTime || null,
      location: ev.location || "",
      meetLink: ev.hangoutLink || "",
      attendees: attendees.map((a) => a.displayName || a.email),
    },
    emails: emailLists.flat(),
  };
}

function describeMeetingPrep(prep, tzOffsetMin) {
  if (!prep || !prep.event) return "";
  const e = prep.event;
  const local = new Date(new Date(e.start).getTime() + tzOffsetMin * 60_000)
    .toISOString().replace("T", " ").slice(0, 16);
  let out =
    `NEXT MEETING: "${e.title}" at ${local} (user's local time)` +
    (e.location ? ` @ ${e.location}` : "") +
    (e.attendees.length ? `; with ${e.attendees.join(", ")}` : "");
  if (prep.emails.length) {
    out +=
      "\nRECENT EMAILS FROM THE SAME PEOPLE:\n" +
      prep.emails
        .map((m) => `- From ${m.from}: "${m.subject}" — ${m.snippet.slice(0, 120)}`)
        .join("\n");
  }
  return out;
}

module.exports = {
  recentEmails, upcomingEvents, describeEmails, describeEvents,
  createDraft, messageMeta, createEvent, updateEvent,
  meetingPrep, describeMeetingPrep,
};
