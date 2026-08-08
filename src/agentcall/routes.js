/**
 * AGENT CALLS — "call Allen Lobo and ask him what time he'll be home."
 * Telephony: PLIVO (India-capable — rents real +91 numbers with domestic
 * routing once business KYC is approved; works over international routes
 * meanwhile with the identical code path).
 *
 * App-facing (behind appAuth, mounted in server.js):
 *   POST /agent-call            {toNumber, contactName, task, lang?} → {id, state}
 *   GET  /agent-call/:id        → {id, state, result, contactName, transcript}
 *
 * Plivo-facing (NO app JWT — Plivo's servers call these; each request is
 * authenticated by its X-Plivo-Signature-V2 instead):
 *   POST /agent-call/plivo/:id/answer   contact picked up → opening XML
 *   POST /agent-call/plivo/:id/input    contact's speech → next AI turn
 *   POST /agent-call/plivo/:id/hangup   call ended (any reason)
 *
 * Flow: app POSTs → Plivo dials the contact → contact picks up → /answer
 * speaks the opening question while listening → /input loops (AI decides
 * each reply, hangs up when the goal is met) → /hangup triggers the
 * summary → the app's poll sees state=completed and SPEAKS the result.
 */
const express = require("express");
const store = require("./store");
const plivo = require("./plivo");
const audit = require("../audit/log");
const engine = require("./engine");
const { findById } = require("../db");
const { meterAgentSeconds } = require("../billing/routes");

const router = express.Router();

// Plivo posts application/x-www-form-urlencoded.
router.use(express.urlencoded({ extended: false }));

// ---------------- app-facing ----------------

// ---- G2: the user's calling rules ----
router.get("/settings", async (req, res) => {
  const st = await store.getSettings(req.user.sub);
  res.json({
    enabled: !!st.enabled,
    dailyLimit: st.daily_limit,
    hoursStart: st.hours_start,
    hoursEnd: st.hours_end,
    usedToday: await store.countToday(req.user.sub, tz(req)),
  });
});

router.put("/settings", async (req, res) => {
  const b = req.body || {};
  const st = await store.setSettings(req.user.sub, {
    enabled: b.enabled,
    daily_limit: b.dailyLimit,
    hours_start: b.hoursStart,
    hours_end: b.hoursEnd,
  });
  res.json({
    enabled: !!st.enabled,
    dailyLimit: st.daily_limit,
    hoursStart: st.hours_start,
    hoursEnd: st.hours_end,
  });
});

/** G2 — PREVIEW: exactly what Hari will say when the contact answers.
 *  Nothing is dialed; the app speaks this and asks for approval. */
router.post("/preview", async (req, res) => {
  const { contactName, task, lang } = req.body || {};
  const name = String(contactName || "").trim().slice(0, 80);
  const what = String(task || "").trim().slice(0, 500);
  if (!name || !what) {
    return res.status(400).json({ error: "contactName and task required" });
  }
  const rule = await checkRules(req);
  const user = await findById(Number(req.user.sub));
  const opening = await engine.openingLine(
    { contact_name: name, task: what, lang: String(lang || "en-IN") },
    user?.name
  );
  res.json({ opening, allowed: !rule, reason: rule || null });
});

const tz = (req) => {
  const n = Number(req.get("x-tz-offset"));
  return Number.isFinite(n) ? n : 330;
};

/** null when the call may proceed; else a ready-to-speak refusal. */
async function checkRules(req) {
  const st = await store.getSettings(req.user.sub);
  if (!st.enabled) {
    return "AI calling is switched off in your call settings.";
  }
  const t = tz(req);
  const hour = Math.floor(((Date.now() + t * 60_000) % 864e5) / 36e5);
  if (hour < st.hours_start || hour >= st.hours_end) {
    return `Your call rules only allow calls between ${st.hours_start}:00 and ${st.hours_end}:00 — I'll hold off.`;
  }
  if ((await store.countToday(req.user.sub, t)) >= st.daily_limit) {
    return `You've reached your daily limit of ${st.daily_limit} AI calls. You can raise it in call settings.`;
  }
  return null;
}

router.post("/", async (req, res) => {
  if (!plivo.configured()) {
    return res.status(503).json({
      error:
        "agent calling not configured — set PLIVO_AUTH_ID, " +
        "PLIVO_AUTH_TOKEN, PLIVO_FROM_NUMBER and PUBLIC_BASE_URL",
    });
  }
  const ruleBlock = await checkRules(req); // G2 — user-set limits, hours, master switch
  if (ruleBlock) {
    return res.status(403).json({ error: "call_rules", say: ruleBlock });
  }
  const { toNumber, contactName, task, lang } = req.body || {};
  const to = plivo.toE164(toNumber);
  if (!to) return res.status(400).json({ error: "valid toNumber required" });
  const name = String(contactName || "").trim().slice(0, 80);
  const what = String(task || "").trim().slice(0, 500);
  if (!name || !what) {
    return res.status(400).json({ error: "contactName and task required" });
  }

  const call = await store.create({
    userId: req.user.sub,
    contactName: name,
    toNumber: to,
    task: what,
    lang: String(lang || "en-IN").slice(0, 10),
  });

  try {
    const uuid = await plivo.createCall({ to, callId: call.id });
    await store.setProviderId(call.id, uuid);
    await store.setState(call.id, "dialing");
    audit.record(req.user.sub, "call.placed", `to ${name} — ${what.slice(0, 120)}`);
    res.status(202).json({ id: call.id, state: "dialing" });
  } catch (e) {
    console.error("agent-call create failed:", e.message);
    await store.setResult(call.id, null, "failed");
    res.status(502).json({ error: "could not place the call" });
  }
});

router.get("/:id", async (req, res) => {
  const call = await store.get(req.params.id);
  if (!call || String(call.user_id) !== String(req.user.sub)) {
    return res.status(404).json({ error: "not found" });
  }
  res.json({
    id: call.id,
    state: call.state,
    contactName: call.contact_name,
    task: call.task,
    result: call.result,
    transcript: call.transcript,
  });
});

// ---------------- Plivo webhooks ----------------

/** Signature + call-exists guard shared by all webhooks. */
async function webhookGuard(req, res) {
  if (!plivo.validSignature(req)) {
    res.status(403).type("text/plain").send("bad signature");
    return null;
  }
  const call = await store.get(req.params.id);
  if (!call) {
    res.status(404).type("text/plain").send("unknown call");
    return null;
  }
  return call;
}

const inputUrl = (id) =>
  `${(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "")}` +
  `/agent-call/plivo/${id}/input`;

/** The contact picked up: speak the opening question while listening.
 *  (Voicemail never reaches here — machine_detection=hangup ends those
 *  calls at Plivo; /hangup then marks them no_answer.) */
router.post("/plivo/:id/answer", async (req, res) => {
  const call = await webhookGuard(req, res);
  if (!call) return;

  await store.setState(call.id, "in_progress");

  // /assistant call-and-inform: the opening was pre-rendered as audio in
  // the user's enrolled (cloned) voice — <Play> it instead of carrier TTS.
  if (call.opening_audio_url) {
    await store.addTurn(call.id, "agent", "[played user's voice message]");
    return res.type("text/xml").send(
      plivo.xmlPlayGetInput({
        audioUrl: call.opening_audio_url,
        actionUrl: inputUrl(call.id),
        lang: call.lang,
      })
    );
  }

  const user = /^\d+$/.test(String(call.user_id))
    ? await findById(Number(call.user_id))
    : null;
  const opening = await engine.openingLine(call, user?.name);
  await store.addTurn(call.id, "agent", opening);
  res.type("text/xml").send(
    plivo.xmlSpeakGetInput({
      text: opening,
      actionUrl: inputUrl(call.id),
      lang: call.lang,
    })
  );
});

/** The contact spoke (or stayed silent): AI decides the next line. */
router.post("/plivo/:id/input", async (req, res) => {
  const call = await webhookGuard(req, res);
  if (!call) return;

  const heard = String(req.body.Speech || req.body.speech || "").trim();
  if (heard) await store.addTurn(call.id, "contact", heard);

  // Silence twice in a row → give up gracefully instead of looping.
  const silentBefore = !heard && call.transcript.at(-1)?.who === "agent";
  if (!heard && silentBefore && call.transcript.length > 2) {
    const bye = "I couldn't hear you clearly. I'll let them know I called. Goodbye!";
    await store.addTurn(call.id, "agent", bye);
    finishCall(call.id);
    return res
      .type("text/xml")
      .send(plivo.xmlSpeakHangup({ text: bye, lang: call.lang }));
  }

  const fresh = await store.get(call.id);
  const turn = heard
    ? await engine.nextTurn(fresh, heard)
    : { say: "Sorry, could you say that again?", done: false };
  await store.addTurn(call.id, "agent", turn.say);

  if (turn.done) {
    finishCall(call.id);
    return res
      .type("text/xml")
      .send(plivo.xmlSpeakHangup({ text: turn.say, lang: call.lang }));
  }
  res.type("text/xml").send(
    plivo.xmlSpeakGetInput({
      text: turn.say,
      actionUrl: inputUrl(call.id),
      lang: call.lang,
    })
  );
});

/** The call ended — any reason, either side. */
router.post("/plivo/:id/hangup", async (req, res) => {
  const call = await webhookGuard(req, res);
  if (!call) return;

  // Meter REAL talk time against the user's plan (family pool included).
  // BillDuration = seconds the answered leg lasted; 0 for unanswered.
  const seconds = parseInt(req.body.BillDuration || req.body.Duration || "0", 10);
  if (seconds > 0 && call.state !== "dialing") {
    meterAgentSeconds(call.user_id, seconds);
  }
  const cause = String(req.body.HangupCause || "").toUpperCase();
  const status = String(req.body.CallStatus || "").toLowerCase();
  const machine = /MACHINE/.test(cause);
  const notAnswered =
    machine ||
    ["busy", "no-answer", "cancel", "timeout"].includes(status) ||
    ["NO_ANSWER", "USER_BUSY", "ORIGINATOR_CANCEL", "NO_USER_RESPONSE"].includes(cause);

  if (store.isDone(call.state)) {
    // already terminal (we hung up after finishing) — nothing to do
  } else if (call.state === "dialing" && notAnswered) {
    await store.setResult(
      call.id,
      machine
        ? `${call.contact_name} didn't pick up — the call went to voicemail.`
        : `${call.contact_name} didn't answer the call.`,
      "no_answer"
    );
  } else if (call.state === "dialing") {
    await store.setResult(
      call.id,
      `I couldn't reach ${call.contact_name} — the call failed.`,
      "failed"
    );
  } else {
    // Was mid-conversation: contact hung up early — summarize what we got.
    finishCall(call.id);
  }
  res.type("text/plain").send("ok");
});

/** Fire-and-forget: generate the user-facing summary, mark completed. */
async function finishCall(id) {
  const call = await store.get(id);
  if (!call || store.isDone(call.state)) return;
  await store.setState(id, "summarizing");
  engine
    .summarize(call)
    .then((summary) => store.setResult(id, summary, "completed"))
    .catch(() => {
      const said = call.transcript
        .filter((t) => t.who === "contact")
        .map((t) => t.text)
        .join(" ");
      store.setResult(
        id,
        said
          ? `I spoke with ${call.contact_name}. They said: ${said}`
          : `The call with ${call.contact_name} ended.`,
        "completed"
      );
    });
}

module.exports = router;
