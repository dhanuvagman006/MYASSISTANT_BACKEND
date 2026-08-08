/**
 * TEXT-TO-SPEECH / VOICE CLONING — ElevenLabs adapter + voice profiles.
 *
 * Enrollment: the app uploads ~30-60s of the user's speech; we create an
 * ElevenLabs instant voice clone and remember its voice_id per user in a
 * self-migrating Postgres table (no db.js changes needed).
 *
 * Synthesis: given text + user, returns a URL to a generated mp3:
 *   - user has an enrolled voice  -> cloned voice
 *   - otherwise                   -> ELEVENLABS_DEFAULT_VOICE_ID or the
 *                                    provider default assistant voice
 *   - no ELEVENLABS_API_KEY       -> returns null; callers fall back to
 *                                    on-device TTS (app) / Plivo TTS (call)
 *
 * Generated audio lives in os.tmpdir() and is served by
 * GET /assistant/audio/:id (public, 32-hex unguessable id — Plivo must be
 * able to fetch it without our JWT). Files are reaped after 30 minutes.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { run, one } = require("../db");

const AUDIO_DIR = path.join(os.tmpdir(), "myassistant-audio");
const AUDIO_TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 30_000;

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = run(`
      CREATE TABLE IF NOT EXISTS voice_profiles (
        user_id     TEXT PRIMARY KEY,
        provider    TEXT NOT NULL DEFAULT 'elevenlabs',
        voice_id    TEXT NOT NULL,
        label       TEXT,
        created_at  BIGINT NOT NULL
      )
    `);
  }
  return tableReady;
}

const configured = () => Boolean(process.env.ELEVENLABS_API_KEY);

async function getProfile(userId) {
  await ensureTable();
  return one("SELECT * FROM voice_profiles WHERE user_id = $1", [String(userId)]);
}

async function deleteProfile(userId) {
  await ensureTable();
  const p = await getProfile(userId);
  if (p && configured()) {
    // Best-effort remote cleanup; the local row is the source of truth.
    fetch(`https://api.elevenlabs.io/v1/voices/${p.voice_id}`, {
      method: "DELETE",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    }).catch(() => {});
  }
  await run("DELETE FROM voice_profiles WHERE user_id = $1", [String(userId)]);
}

/**
 * Instant voice clone from one uploaded sample.
 * @param {{buffer: Buffer, mimetype: string, originalname: string}} file
 */
async function enrollVoice(userId, file, label = "My voice") {
  if (!configured()) {
    const err = new Error("voice cloning not configured (ELEVENLABS_API_KEY)");
    err.code = "not_configured";
    throw err;
  }
  await ensureTable();
  const fd = new FormData();
  fd.append("name", `user-${userId}`.slice(0, 60));
  fd.append(
    "files",
    new Blob([file.buffer], { type: file.mimetype || "audio/m4a" }),
    file.originalname || "sample.m4a"
  );
  const r = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    signal: AbortSignal.timeout(60_000),
    body: fd,
  });
  if (!r.ok) throw new Error(`elevenlabs enroll ${r.status}`);
  const data = await r.json();
  if (!data.voice_id) throw new Error("elevenlabs: no voice_id returned");
  await run(
    `INSERT INTO voice_profiles (user_id, provider, voice_id, label, created_at)
     VALUES ($1, 'elevenlabs', $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       voice_id = EXCLUDED.voice_id, label = EXCLUDED.label,
       created_at = EXCLUDED.created_at`,
    [String(userId), data.voice_id, String(label).slice(0, 80), Date.now()]
  );
  return { voiceId: data.voice_id };
}

/**
 * Synthesize `text`; returns { audioId, url } or null when TTS is not
 * configured (callers then use device/Plivo TTS — the flow never breaks).
 */
async function synthesize(userId, text, { publicBaseUrl } = {}) {
  if (!configured()) return null;
  const profile = userId ? await getProfile(userId).catch(() => null) : null;
  const voiceId =
    profile?.voice_id ||
    process.env.ELEVENLABS_DEFAULT_VOICE_ID ||
    "21m00Tcm4TlvDq8ikWAM"; // ElevenLabs "Rachel" — stock assistant voice

  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        text: String(text).slice(0, 2000),
        model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
      }),
    }
  );
  if (!r.ok) throw new Error(`elevenlabs tts ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const audioId = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(path.join(AUDIO_DIR, `${audioId}.mp3`), buf);
  const base = (publicBaseUrl || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return {
    audioId,
    url: `${base}/assistant/audio/${audioId}`,
    usedClonedVoice: Boolean(profile),
  };
}

/** Path for the serving route; null when unknown/expired. */
function audioPath(audioId) {
  if (!/^[a-f0-9]{32}$/.test(String(audioId))) return null;
  const p = path.join(AUDIO_DIR, `${audioId}.mp3`);
  return fs.existsSync(p) ? p : null;
}

// Reap old audio files.
setInterval(() => {
  try {
    if (!fs.existsSync(AUDIO_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(AUDIO_DIR)) {
      const p = path.join(AUDIO_DIR, f);
      if (now - fs.statSync(p).mtimeMs > AUDIO_TTL_MS) fs.unlinkSync(p);
    }
  } catch (_) {}
}, 5 * 60_000).unref();

module.exports = {
  configured,
  getProfile,
  deleteProfile,
  enrollVoice,
  synthesize,
  audioPath,
};
