/**
 * AGENT CALLS — "call Allen Lobo and ask him what time he'll be home."
 *
 * App-facing (behind appAuth, mounted in server.js):
 *   POST /agent-call            {toNumber, contactName, task, lang?} → {id, state}
 *   GET  /agent-call/:id        → {id, state, result, contactName, transcript}
 *
 * Twilio-facing (NO app JWT — Twilio's servers call these; each request
 * is authenticated by its X-Twilio-Signature instead):
 *   POST /agent-call/twilio/:id/voice    first TwiML (opening line + listen)
 *   POST /agent-call/twilio/:id/gather   contact's speech → next AI turn
 *   POST /agent-call/twilio/:id/status   ringing/answered/no-answer/ended
 *
 * Flow: app POSTs → Twilio dials the contact → contact picks up → /voice
 * speaks the opening question → /gather loops (AI decides each reply,
 * hangs up when the goal is met) → /status "completed" triggers the
 * summary → the app's poll sees state=completed and SPEAKS the result.
 */
const express = require("express");
const store = require("./store");
const twilio = require("./twilio");
const engine = require("./engine");
const { findById } = require("../db");

const router = express.Router();

// Twilio posts application/x-www-form-urlencoded.
router.use(express.urlencoded({ extended: false }));

// ---------------- app-facing ----------------

router.post("/", async (req, res) => {
  if (!twilio.configured()) {
    return res.status(503).json({
      error:
        "agent calling not configured — set TWILIO_ACCOUNT_SID, " +
        "TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER and PUBLIC_BASE_URL",
    });
  }
  const { toNumber, contactName, task, lang } = req.body || {};
  const to = twilio.toE164(toNumber);
  if (!to) return res.status(400).json({ error: "valid toNumber required" });
  const name = String(contactName || "").trim().slice(0, 80);
  const what = String(task || "").trim().slice(0, 500);
  if (!name || !what) {
    return res.status(400).json({ error: "contactName and task required" });
  }

  const call = store.create({
    userId: req.user.sub,
    contactName: name,
    toNumber: to,
    task: what,
    lang: String(lang || "en-IN").slice(0, 10),
  });

  try {
    const sid = await twilio.createCall({ to, callId: call.id });
    store.setTwilioSid(call.id, sid);
    store.setState(call.id, "dialing");
    res.status(202).json({ id: call.id, state: "dialing" });
  } catch (e) {
    console.error("agent-call create failed:", e.message);
    store.setResult(call.id, null, "failed");
    res.status(502).json({ error: "could not place the call" });
  }
});

router.get("/:id", (req, res) => {
  const call = store.get(req.params.id);
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

// ---------------- Twilio webhooks ----------------

/** Signature + call-exists guard shared by all three webhooks. */
function webhookGuard(req, res) {
  if (!twilio.validSignature(req)) {
    res.status(403).type("text/plain").send("bad signature");
    return null;
  }
  const call = store.get(req.params.id);
  if (!call) {
    res.status(404).type("text/plain").send("unknown call");
    return null;
  }
  return call;
}

const gatherUrl = (id) =>
  `${(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "")}` +
  `/agent-call/twilio/${id}/gather`;

/** The contact picked up: speak the opening question, then listen. */
router.post("/twilio/:id/voice", async (req, res) => {
  const call = webhookGuard(req, res);
  if (!call) return;

  // Voicemail answered instead of a human — don't interrogate a robot.
  const answeredBy = String(req.body.AnsweredBy || "");
  if (answeredBy.startsWith("machine")) {
    store.setResult(
      call.id,
      `${call.contact_name} didn't pick up — the call went to voicemail.`,
      "no_answer"
    );
    return res
      .type("text/xml")
      .send(twilio.twimlSayHangup({ text: "", lang: call.lang }));
  }

  store.setState(call.id, "in_progress");
  const user = /^\d+$/.test(String(call.user_id))
    ? findById(Number(call.user_id))
    : null;
  const opening = await engine.openingLine(call, user?.name);
  store.addTurn(call.id, "agent", opening);
  res.type("text/xml").send(
    twilio.twimlSayGather({
      text: opening,
      actionUrl: gatherUrl(call.id),
      lang: call.lang,
    })
  );
});

/** The contact spoke (or stayed silent): AI decides the next line. */
router.post("/twilio/:id/gather", async (req, res) => {
  const call = webhookGuard(req, res);
  if (!call) return;

  const heard = String(req.body.SpeechResult || "").trim();
  if (heard) store.addTurn(call.id, "contact", heard);

  // Silence twice in a row → give up gracefully instead of looping.
  const silentBefore = !heard && call.transcript.at(-1)?.who === "agent";
  if (!heard && silentBefore && call.transcript.length > 2) {
    const bye = "I couldn't hear you clearly. I'll let them know I called. Goodbye!";
    store.addTurn(call.id, "agent", bye);
    finishCall(call.id);
    return res
      .type("text/xml")
      .send(twilio.twimlSayHangup({ text: bye, lang: call.lang }));
  }

  const fresh = store.get(call.id);
  const turn = heard
    ? await engine.nextTurn(fresh, heard)
    : { say: "Sorry, could you say that again?", done: false };
  store.addTurn(call.id, "agent", turn.say);

  if (turn.done) {
    finishCall(call.id);
    return res
      .type("text/xml")
      .send(twilio.twimlSayHangup({ text: turn.say, lang: call.lang }));
  }
  res.type("text/xml").send(
    twilio.twimlSayGather({
      text: turn.say,
      actionUrl: gatherUrl(call.id),
      lang: call.lang,
    })
  );
});

/** Lifecycle events: no-answer/busy/failed, and completed → summarize. */
router.post("/twilio/:id/status", (req, res) => {
  const call = webhookGuard(req, res);
  if (!call) return;
  const status = String(req.body.CallStatus || "");

  if (["no-answer", "busy", "canceled"].includes(status)) {
    store.setResult(
      call.id,
      `${call.contact_name} didn't answer the call.`,
      "no_answer"
    );
  } else if (status === "failed") {
    store.setResult(
      call.id,
      `I couldn't reach ${call.contact_name} — the call failed.`,
      "failed"
    );
  } else if (status === "completed" && !store.isDone(call.state)) {
    // Hung up (either side) without our explicit finish — summarize anyway.
    finishCall(call.id);
  }
  res.type("text/plain").send("ok");
});

/** Fire-and-forget: generate the user-facing summary, mark completed. */
function finishCall(id) {
  const call = store.get(id);
  if (!call || store.isDone(call.state)) return;
  store.setState(id, "summarizing");
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
