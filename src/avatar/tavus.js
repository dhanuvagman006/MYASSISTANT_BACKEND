/**
 * AVATAR — real-time human face via Tavus CVI (tavusapi.com).
 *
 * ARCHITECTURE (Re-architecture directive): Tavus is the MEDIA layer
 * only — realtime video, audio, lip-sync, barge-in (§10). The BRAIN is
 * this backend's unified agent, wired in through a per-user Tavus
 * persona whose custom-LLM layer calls back to /avatar/llm (see
 * llm.js). Identity, memory, tools, MCP, standing rules and permissions
 * all live here (§3, §11–§14), so the provider can be replaced later
 * (e.g. a LiveKit room + avatar worker) without rebuilding the
 * assistant — the /avatar/llm boundary is the seam.
 *
 * PERSISTENT ASSISTANT (§1, §4–§6): every session context is built from
 * the authenticated user's stored data — user profile, assistant
 * profile, standing instructions, memories, people/cases, and a rolling
 * recent-conversation window (state.js). A new room every launch, the
 * SAME assistant every launch.
 *
 * NO NAME PROMPT (§2, §25): the app loads /avatar/room (room.js), which
 * auto-joins with the profile name — Daily's "Enter your name"
 * haircheck never appears.
 *
 * Env:
 *   TAVUS_API_KEY          required
 *   TAVUS_FACE_ID          required (default/female replica)
 *   TAVUS_FACE_ID_MALE     optional male replica (§16 opposite-gender)
 *   PUBLIC_URL             https base of THIS server reachable by Tavus.
 *                          Required for the unified-agent brain + webhook;
 *                          without it, sessions fall back to Tavus's own
 *                          LLM (media works, tools/MCP don't) and /status
 *                          reports brain:"provider" so nothing is faked.
 *   TAVUS_PAL_ID           legacy optional persona override
 *   TAVUS_MAX_CALL_SECONDS optional, default 900
 *
 * Routes (mounted with auth):    GET /avatar/status, POST /avatar/session
 * Routes (mounted public):       /avatar/room (room.js), /avatar/llm
 *                                (llm.js), POST /avatar/webhook
 */
const router = require("express").Router();
const crypto = require("crypto");
const { one, run, query } = require("../db");
const memory = require("../agents/memory");
const userContext = require("../users/context");
const convoState = require("./state");

const TAVUS_BASE = "https://tavusapi.com";
const enabled = () =>
  Boolean(process.env.TAVUS_API_KEY && process.env.TAVUS_FACE_ID);
const publicUrl = () =>
  String(process.env.PUBLIC_URL || "").replace(/\/+$/, "");

function uidOf(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function tavus(path, method, body) {
  const r = await fetch(`${TAVUS_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.TAVUS_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json: j };
}

/* ------------------------------------------------------------------ */
/* Greeting helpers (§15/§16 of the first directive)                   */
/* ------------------------------------------------------------------ */

function partOfDay(hour) {
  if (!Number.isFinite(hour)) return "";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

function resolveLocalHour(body, profile) {
  const h = Number(body?.localHour);
  if (Number.isInteger(h) && h >= 0 && h <= 23) return h;
  const tz = profile?.user?.timezone;
  if (tz) {
    try {
      return Number(
        new Intl.DateTimeFormat("en-GB", {
          hour: "numeric", hour12: false, timeZone: tz,
        }).format(new Date())
      );
    } catch (_) {}
  }
  return NaN;
}

/* ------------------------------------------------------------------ */
/* Per-user persona: the brain hookup (§10)                            */
/* ------------------------------------------------------------------ */

/**
 * Ensures this user has a Tavus persona whose LLM layer points at OUR
 * /avatar/llm with a per-user bearer key. Created once, reused forever
 * (§6 — same assistant, new sessions). Returns null when PUBLIC_URL is
 * unset (no reachable brain endpoint → honest provider-brain fallback).
 */
async function ensurePersona(userId, assistantName) {
  if (!publicUrl() || !userId) return null;
  const existing = await one(
    `SELECT persona_id, api_key FROM avatar_personas WHERE user_id=$1`,
    [userId]
  );
  if (existing) return existing;

  const apiKey = crypto.randomBytes(32).toString("hex");
  const { ok, json, status } = await tavus("/v2/personas", "POST", {
    persona_name: `myassistant-user-${userId}`,
    system_prompt:
      "You are the user's personal assistant. Follow the conversational " +
      "context provided with each conversation.",
    layers: {
      llm: {
        model: "myassistant-agent",
        base_url: `${publicUrl()}/avatar/llm`,
        api_key: apiKey,
      },
    },
  });
  const personaId = json?.persona_id;
  if (!ok || !personaId) {
    console.error(
      "tavus persona create failed:",
      json?.message || json?.error || `HTTP ${status}`
    );
    return null;
  }
  await run(
    `INSERT INTO avatar_personas (user_id, persona_id, api_key, created_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET persona_id=$2, api_key=$3`,
    [userId, personaId, apiKey, Date.now()]
  );
  console.log(`avatar: persona ${personaId} created for user ${userId} (${assistantName})`);
  return { persona_id: personaId, api_key: apiKey };
}

/* ------------------------------------------------------------------ */
/* Session context (§4): identity + rules + memory + people + recency  */
/* ------------------------------------------------------------------ */

async function buildSession(userId, body) {
  let profile = null;
  let instructions = [];
  let facts = [];
  let people = [];
  let recent = "";
  if (userId) {
    try { profile = await userContext.getProfile(userId); } catch (_) {}
    try { instructions = await userContext.listInstructions(userId); } catch (_) {}
    try { facts = await memory.listMemories(userId); } catch (_) {}
    try { recent = await convoState.getSummary(userId); } catch (_) {}
    try {
      people = await query(
        `SELECT name, summary FROM clients
          WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 6`,
        [userId]
      );
    } catch (_) {}
  }

  const userName = profile?.user?.name?.trim() || "";
  const userGender = String(profile?.user?.gender || "").toLowerCase();
  const assistant =
    profile?.assistant || { name: "Hari", gender: "", voice: "", style: "" };
  const assistantName = assistant.name || "Hari";

  let gender = String(assistant.gender || "").toLowerCase();
  if (!gender) {
    gender =
      userGender === "female" ? "male" : userGender === "male" ? "female" : "";
  }
  const faceId =
    gender === "male" && process.env.TAVUS_FACE_ID_MALE
      ? process.env.TAVUS_FACE_ID_MALE
      : process.env.TAVUS_FACE_ID;

  const pod = partOfDay(resolveLocalHour(body, profile));
  const hello = pod ? `Good ${pod}` : "Hello";
  const greeting = userName
    ? `${hello}, ${userName}. I'm ${assistantName}. How can I help you today?`
    : `${hello}. I'm ${assistantName}. How can I help you today?`;

  const styleLine =
    assistant.style === "concise" ? "Keep replies short and to the point. " :
    assistant.style === "formal" ? "Keep a polished, professional tone. " :
    assistant.style === "friendly" ? "Be warm and personable. " : "";
  const rules = instructions.length
    ? "The user's standing rules — always respect them: " +
      instructions.map((r) => r.instruction).join("; ") + ". "
    : "";
  const memoryLine = facts.length
    ? "Things you remember about them from earlier conversations " +
      "(use naturally, never recite): " +
      facts.map((r) => r.fact).join("; ") + ". "
    : "";
  const peopleLine = people.length
    ? "People in their world: " +
      people
        .map((p) => p.summary ? `${p.name} (${p.summary})` : p.name)
        .join("; ") + ". "
    : "";
  const recentLine = recent
    ? "The tail of your recent conversation with them (possibly from an " +
      "earlier session — continue naturally from it):\n" + recent + "\n"
    : "";
  const userLine = userName ? `The user's name is ${userName}. ` : "";

  const context =
    `You are ${assistantName}, the user's warm, quick-witted personal ` +
    "assistant — the same assistant they talk to every day. Speak " +
    "naturally like a human on a video call: contractions, short " +
    "sentences, one thought at a time. Match the user's language. " +
    styleLine + userLine + rules + memoryLine + peopleLine + recentLine +
    "Never mention being an avatar or AI unless directly asked; if asked, " +
    "answer honestly and lightly, then move on.";

  return { faceId, assistantName, userName, greeting, context };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

router.get("/status", (_req, res) =>
  res.json({
    enabled: enabled(),
    // Honest capability flag: with no PUBLIC_URL the live session runs
    // on the provider's own LLM — media works, tools/memory-writes from
    // live speech don't. The app/diagnostics can surface this.
    brain: publicUrl() ? "unified-agent" : "provider",
  })
);

router.post("/session", async (req, res) => {
  if (!enabled()) {
    return res.status(503).json({ error: "avatar not configured" });
  }
  const userId = uidOf(req);
  try {
    const s = await buildSession(userId, req.body || {});
    const persona = await ensurePersona(userId, s.assistantName).catch(() => null);

    const body = {
      face_id: s.faceId,
      conversational_context: s.context,
      custom_greeting: s.greeting,
      properties: {
        language: "multilingual",
        max_call_duration: Number(process.env.TAVUS_MAX_CALL_SECONDS) || 900,
        participant_left_timeout: 30,
        participant_absent_timeout: 120,
      },
    };
    if (persona?.persona_id) body.persona_id = persona.persona_id;
    else if (process.env.TAVUS_PAL_ID) body.pal_id = process.env.TAVUS_PAL_ID;
    if (publicUrl()) body.callback_url = `${publicUrl()}/avatar/webhook`;

    const { ok, status, json: j } = await tavus("/v2/conversations", "POST", body);
    if (!ok || !j?.conversation_url) {
      const msg = j?.message || j?.error || `HTTP ${status}`;
      console.error("tavus session failed:", msg);
      return res
        .status(502)
        .json({ error: "avatar session failed", detail: String(msg).slice(0, 200) });
    }

    // Session record: temporary room → persistent user (§20).
    if (userId && j.conversation_id) {
      await run(
        `INSERT INTO avatar_sessions (conversation_id, user_id, started_at)
         VALUES ($1,$2,$3) ON CONFLICT (conversation_id) DO NOTHING`,
        [String(j.conversation_id), userId, Date.now()]
      ).catch(() => {});
    }

    // The app loads OUR room page: auto-join as the authenticated user,
    // no name prompt, no meeting chrome (§2, §29).
    const host = `${req.protocol}://${req.get("host")}`;
    const roomUrl =
      `${host}/avatar/room?u=${encodeURIComponent(j.conversation_url)}` +
      `&n=${encodeURIComponent(s.userName || "You")}`;

    res.json({
      url: j.conversation_url, // raw provider URL (fallback/debug)
      roomUrl,
      conversationId: j.conversation_id,
      assistantName: s.assistantName,
      brain: persona ? "unified-agent" : "provider",
    });
  } catch (e) {
    console.error("tavus error:", e.message);
    res.status(502).json({ error: "avatar unavailable" });
  }
});

/* ------------------------------------------------------------------ */
/* Webhook (public mount): the temporary session feeds the persistent  */
/* assistant (§5, §19, §20)                                            */
/* ------------------------------------------------------------------ */

const webhook = require("express").Router();
webhook.post("/", require("express").json({ limit: "2mb" }), async (req, res) => {
  res.json({ ok: true }); // ack fast; processing is best-effort
  try {
    const ev = req.body || {};
    const conversationId = String(
      ev.conversation_id || ev.properties?.conversation_id || ""
    );
    if (!conversationId) return;
    const row = await one(
      `SELECT user_id FROM avatar_sessions WHERE conversation_id=$1`,
      [conversationId]
    );
    if (!row) return;
    const userId = Number(row.user_id);
    const type = String(ev.event_type || ev.type || "");

    if (type === "system.shutdown" || type === "conversation.ended") {
      await run(
        `UPDATE avatar_sessions SET ended_at=$2 WHERE conversation_id=$1`,
        [conversationId, Date.now()]
      );
    }

    // End-of-call transcript → rolling recency window + durable memory.
    if (type === "application.transcription_ready") {
      const turns = Array.isArray(ev.properties?.transcript)
        ? ev.properties.transcript
        : [];
      let lastUser = "";
      for (const t of turns.slice(-24)) {
        const role = String(t.role || "");
        const content = String(t.content || "").trim();
        if (!content || role === "system") continue;
        if (role === "user") {
          lastUser = content;
          memory.extractAndStore(userId, content);
        } else {
          await convoState.appendTurn(userId, lastUser, content);
          lastUser = "";
        }
      }
      if (lastUser) await convoState.appendTurn(userId, lastUser, "");
    }
  } catch (e) {
    console.error("avatar webhook error:", e.message);
  }
});

module.exports = router;
module.exports.webhook = webhook;
module.exports.buildSession = buildSession; // for tests
module.exports.ensurePersona = ensurePersona;
