/**
 * LIVE MODE — real speech-to-speech via the Gemini Live API.
 *
 * This replaces the whole record → STT → LLM → TTS pipeline with ONE
 * bidirectional stream: the app sends raw PCM (16 kHz mono s16le) up as it
 * is captured, and Gemini's native-audio model streams SPOKEN AUDIO back
 * (24 kHz mono s16le). There is no transcription step, end-of-speech is
 * detected server-side by Google (no client VAD guessing), and barge-in is
 * native: talking over Hari interrupts her mid-word.
 *
 * The API key must never reach the app, so the app connects HERE and this
 * module proxies frames to Google:
 *
 *   app  ──ws──  /live/ws?token=…  ──wss──  BidiGenerateContent
 *
 * Wire protocol with the app (deliberately tiny):
 *   app → server   binary frame        = one PCM16/16k mic chunk
 *   app → server   {"type":"end"}      = user closed the session
 *   server → app   binary frame        = one PCM16/24k audio chunk to play
 *   server → app   {"type":"ready"}                    setup complete
 *   server → app   {"type":"interrupted"}              stop playback NOW
 *   server → app   {"type":"turn_complete"}            Hari finished talking
 *   server → app   {"type":"input_transcript","text"}  what the user said
 *   server → app   {"type":"output_transcript","text"} what Hari said
 *   server → app   {"type":"error","message"}          fatal, then close
 *
 * EXPERIMENTAL and feature-flagged: nothing in the classic /assistant loop
 * is touched. If this path fails on a given key/model, the app keeps
 * working exactly as before.
 */
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const { envModel } = require("../services/ai/router");

const LIVE_MODEL = () =>
  envModel("GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio-preview");

const LIVE_VOICE = () => envModel("GEMINI_TTS_VOICE", "Kore");

const GOOGLE_WS =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/// Same auth tiers as the REST middleware, adapted for a WS query string.
function authorize(url) {
  if (process.env.AUTH_DISABLED === "true") return { sub: "anonymous-dev" };
  const token = url.searchParams.get("token") || "";
  if (token) {
    try {
      const { uid } = jwt.verify(token, process.env.JWT_SECRET);
      return { sub: String(uid) };
    } catch (_) {
      return null;
    }
  }
  if (
    process.env.ALLOW_APP_KEY === "true" &&
    process.env.APP_API_KEY &&
    url.searchParams.get("appKey") === process.env.APP_API_KEY
  ) {
    return { sub: "dev" };
  }
  return null;
}

/// The system prompt for live mode. Kept short: the live model speaks, so
/// the TTS-formatting rules from the text prompt don't apply.
function liveSystemPrompt() {
  return (
    "You are Hari, a warm, quick-witted personal voice assistant from India. " +
    "You are SPEAKING with the user in real time. Reply in the same language " +
    "the user speaks — English, Kannada, Hindi, or any mix. Keep replies " +
    "short and conversational, one thought at a time, like a friend on a " +
    "phone call. Never mention being an AI unless directly asked. Decline " +
    "harmful requests politely and briefly."
  );
}

/**
 * Bridges one app socket to one Gemini Live session.
 */
function bridge(appWs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    appWs.send(JSON.stringify({ type: "error", message: "no API key" }));
    appWs.close();
    return;
  }

  let upstream;
  let upstreamReady = false;
  // Mic audio that arrives before Google's setupComplete would be lost —
  // buffer a little so the first word is never clipped.
  const pending = [];

  try {
    // Google's documented WS auth is the key as a query parameter (the
    // connection originates from OUR server, so it never reaches the app).
    upstream = new WebSocket(`${GOOGLE_WS}?key=${encodeURIComponent(key)}`);
  } catch (e) {
    appWs.send(JSON.stringify({ type: "error", message: "connect failed" }));
    appWs.close();
    return;
  }

  const closeBoth = (why) => {
    try {
      appWs.close();
    } catch (_) {}
    try {
      upstream.close();
    } catch (_) {}
    if (why) console.log(`live: session closed (${why})`);
  };

  upstream.on("open", () => {
    upstream.send(
      JSON.stringify({
        setup: {
          model: `models/${LIVE_MODEL()}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: LIVE_VOICE() },
              },
            },
          },
          systemInstruction: { parts: [{ text: liveSystemPrompt() }] },
          // Transcripts of both sides let the app render its chat bubbles
          // even though no text ever drives the conversation.
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      })
    );
  });

  upstream.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }

    if (msg.setupComplete) {
      upstreamReady = true;
      appWs.send(JSON.stringify({ type: "ready", model: LIVE_MODEL() }));
      for (const frame of pending.splice(0)) sendAudioUp(frame);
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      appWs.send(JSON.stringify({ type: "interrupted" }));
    }
    const parts = sc.modelTurn?.parts || [];
    for (const p of parts) {
      const b64 = p.inlineData?.data;
      if (b64) {
        // Raw 24 kHz PCM straight through as binary — no re-encoding.
        appWs.send(Buffer.from(b64, "base64"));
      }
    }
    if (sc.inputTranscription?.text) {
      appWs.send(
        JSON.stringify({
          type: "input_transcript",
          text: sc.inputTranscription.text,
        })
      );
    }
    if (sc.outputTranscription?.text) {
      appWs.send(
        JSON.stringify({
          type: "output_transcript",
          text: sc.outputTranscription.text,
        })
      );
    }
    if (sc.turnComplete) {
      appWs.send(JSON.stringify({ type: "turn_complete" }));
    }
  });

  upstream.on("error", (e) => {
    console.error("live: upstream error:", e.message);
    try {
      appWs.send(
        JSON.stringify({
          type: "error",
          message: `live model unavailable (${String(e.message).slice(0, 120)})`,
        })
      );
    } catch (_) {}
    closeBoth("upstream error");
  });
  upstream.on("close", (code) => closeBoth(`upstream ${code}`));

  function sendAudioUp(chunk) {
    upstream.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: chunk.toString("base64"),
            mimeType: "audio/pcm;rate=16000",
          },
        },
      })
    );
  }

  appWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!upstreamReady) {
        // ~2s of pre-ready audio max, so a stalled setup can't balloon.
        if (pending.length < 64) pending.push(data);
        return;
      }
      sendAudioUp(data);
      return;
    }
    try {
      const m = JSON.parse(data.toString());
      if (m.type === "end") closeBoth("app ended");
    } catch (_) {}
  });

  appWs.on("close", () => closeBoth());
  appWs.on("error", () => closeBoth("app error"));
}

/// Express router for the /live availability probe (registered at app
/// setup time, BEFORE the 404 catch-all).
function probeRouter() {
  const router = require("express").Router();
  router.get("/", (_req, res) => {
    res.json({
      available: Boolean(process.env.GEMINI_API_KEY),
      model: LIVE_MODEL(),
      experimental: true,
    });
  });
  return router;
}

/**
 * Attaches the /live/ws upgrade handler to the HTTP server.
 */
function attachWs(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch (_) {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/live/ws") return; // not ours
    const user = authorize(url);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws));
  });
}

module.exports = { probeRouter, attachWs };
