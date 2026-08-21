#!/usr/bin/env node
/**
 * SARVAM TTS INTEGRATION TESTS
 *
 * Validates the Sarvam Bulbul v3 ↔ Gemini TTS provider chain logic in
 * src/services/ai/router.js WITHOUT calling any real external API.
 * Works by intercepting global.fetch.
 *
 * Run:  node scripts/sarvam-tts-test.js
 */

"use strict";

// ---- helpers ----
let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  ✗ ${msg}`);
}
function section(name) { console.log(`\n— ${name}`); }

// ---- save originals ----
const realFetch = global.fetch;
const origEnv = { ...process.env };

function resetEnv() {
  // Restore to originals, removing anything we added.
  for (const k of Object.keys(process.env)) {
    if (!(k in origEnv)) delete process.env[k];
  }
  Object.assign(process.env, origEnv);
}

// A minimal fake WAV (44 bytes header + 2 bytes PCM silence).
const FAKE_PCM = Buffer.alloc(2);
const FAKE_WAV_B64 = Buffer.concat([
  (() => {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + FAKE_PCM.length, 4);
    h.write("WAVE", 8);
    h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(24000, 24);
    h.writeUInt32LE(48000, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36);
    h.writeUInt32LE(FAKE_PCM.length, 40);
    return h;
  })(),
  FAKE_PCM,
]).toString("base64");

// Gemini-style response with inlineData audio.
function geminiAudioResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            inlineData: {
              mimeType: "audio/L16;rate=24000",
              data: FAKE_PCM.toString("base64"),
            },
          }],
        },
      }],
    }),
    text: async () => "",
  };
}

// Sarvam-style response with audios[] array.
function sarvamAudioResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      request_id: "test_001",
      audios: [FAKE_WAV_B64],
    }),
    text: async () => "",
  };
}

// We need to freshly require router.js for each test group since module-level
// constants read process.env at require-time. To avoid caching issues we
// clear the require cache entry.
function freshRouter() {
  const modPath = require.resolve("../src/services/ai/router");
  delete require.cache[modPath];
  return require(modPath);
}

// ================================================================
(async () => {
  // ----------------------------------------------------------
  section("1. Fallback — no SARVAM_API_KEY: should use Gemini only");
  // ----------------------------------------------------------
  {
    resetEnv();
    delete process.env.SARVAM_API_KEY;
    process.env.GEMINI_API_KEY = "test-gemini-key";
    // Ensure DATABASE_URL is set (db.js requires it at module load)
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://x:x@localhost/x";

    let fetchedUrl = null;
    global.fetch = async (url, opts) => {
      fetchedUrl = String(url);
      // Must be a Gemini URL
      if (fetchedUrl.includes("generativelanguage.googleapis.com")) {
        return geminiAudioResponse();
      }
      throw new Error("unexpected fetch to: " + fetchedUrl);
    };

    const { synthesizeSpeech } = freshRouter();
    const result = await synthesizeSpeech("Namaste, aap kaise hain?", { language: "hi" });

    assert(result.wav instanceof Buffer, "wav should be a Buffer");
    assert(result.wav.length > 0, "wav should not be empty");
    assert(fetchedUrl.includes("generativelanguage"), "should call Gemini when no Sarvam key");
    assert(result.provider === "gemini", "provider should be 'gemini'");
    console.log("  ✓ Gemini-only path works when SARVAM_API_KEY is absent");
  }

  // ----------------------------------------------------------
  section("2. Sarvam-first — SARVAM_API_KEY set + Indian language");
  // ----------------------------------------------------------
  {
    resetEnv();
    process.env.SARVAM_API_KEY = "test-sarvam-key";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://x:x@localhost/x";

    let sarvamCalled = false;
    let sentBody = null;
    let sentHeaders = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("api.sarvam.ai/text-to-speech")) {
        sarvamCalled = true;
        sentBody = JSON.parse(opts.body);
        sentHeaders = opts.headers;
        return sarvamAudioResponse();
      }
      // Gemini fallback — should NOT be reached in this test
      return geminiAudioResponse();
    };

    const { synthesizeSpeech } = freshRouter();
    const result = await synthesizeSpeech("ನಮಸ್ಕಾರ, ಹೇಗಿದ್ದೀರಿ?", { language: "kn" });

    assert(sarvamCalled, "should call Sarvam for Kannada");
    assert(sentBody.model === "bulbul:v3", "model should be bulbul:v3");
    assert(sentBody.language_code === "kn-IN", "language_code should be kn-IN");
    assert(sentBody.speech_sample_rate === 24000, "sample rate should be 24000");
    assert(sentBody.output_audio_codec === "wav", "codec should be wav");
    assert(sentHeaders["api-subscription-key"] === "test-sarvam-key", "should send API key header");
    assert(result.provider === "sarvam", "provider should be 'sarvam'");
    assert(result.wav instanceof Buffer && result.wav.length > 0, "wav should be a non-empty Buffer");
    console.log("  ✓ Sarvam called correctly for Kannada with proper request fields");
  }

  // ----------------------------------------------------------
  section("3. Sarvam error → graceful Gemini fallback");
  // ----------------------------------------------------------
  {
    resetEnv();
    process.env.SARVAM_API_KEY = "test-sarvam-key";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://x:x@localhost/x";

    let geminiFallbackCalled = false;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("api.sarvam.ai")) {
        // Simulate a 502 Bad Gateway
        return { ok: false, status: 502, text: async () => "bad gateway", json: async () => ({}) };
      }
      if (u.includes("generativelanguage.googleapis.com")) {
        geminiFallbackCalled = true;
        return geminiAudioResponse();
      }
      throw new Error("unexpected fetch: " + u);
    };

    const { synthesizeSpeech } = freshRouter();
    const result = await synthesizeSpeech("Namaste", { language: "hi" });

    assert(geminiFallbackCalled, "should fall back to Gemini after Sarvam 502");
    assert(result.provider === "gemini", "provider should be 'gemini' after fallback");
    assert(result.wav instanceof Buffer, "should still return valid audio");
    console.log("  ✓ Sarvam 502 → Gemini fallback works without error to client");
  }

  // ----------------------------------------------------------
  section("4. Non-Indian language → Gemini directly (skips Sarvam)");
  // ----------------------------------------------------------
  {
    resetEnv();
    process.env.SARVAM_API_KEY = "test-sarvam-key";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://x:x@localhost/x";

    let sarvamCalled = false;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("api.sarvam.ai")) {
        sarvamCalled = true;
        return sarvamAudioResponse();
      }
      return geminiAudioResponse();
    };

    const { synthesizeSpeech } = freshRouter();
    const result = await synthesizeSpeech("Bonjour, comment allez-vous?", { language: "fr" });

    assert(!sarvamCalled, "should NOT call Sarvam for French");
    assert(result.provider === "gemini", "provider should be 'gemini' for French");
    console.log("  ✓ Non-Indian language goes straight to Gemini");
  }

  // ----------------------------------------------------------
  section("5. Sarvam timeout → Gemini fallback");
  // ----------------------------------------------------------
  {
    resetEnv();
    process.env.SARVAM_API_KEY = "test-sarvam-key";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://x:x@localhost/x";

    let geminiFallbackCalled = false;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("api.sarvam.ai")) {
        // Simulate a network error / timeout
        throw new Error("fetch timeout simulated");
      }
      if (u.includes("generativelanguage.googleapis.com")) {
        geminiFallbackCalled = true;
        return geminiAudioResponse();
      }
      throw new Error("unexpected fetch: " + u);
    };

    const { synthesizeSpeech } = freshRouter();
    const result = await synthesizeSpeech("Hello", { language: "en" });

    assert(geminiFallbackCalled, "should fall back to Gemini after Sarvam timeout");
    assert(result.provider === "gemini", "provider should be 'gemini' after timeout fallback");
    console.log("  ✓ Sarvam timeout → Gemini fallback works");
  }

  // ----------------------------------------------------------
  section("6. Empty text → error (before any provider call)");
  // ----------------------------------------------------------
  {
    resetEnv();
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://x:x@localhost/x";

    global.fetch = async () => { throw new Error("should not fetch"); };
    const { synthesizeSpeech } = freshRouter();

    let threw = false;
    try {
      await synthesizeSpeech("", { language: "hi" });
    } catch (e) {
      threw = true;
      assert(e.message.includes("empty text"), "error should mention 'empty text'");
    }
    assert(threw, "should throw on empty text");
    console.log("  ✓ Empty text rejected early");
  }

  // ----------------------------------------------------------
  // Summary
  // ----------------------------------------------------------
  global.fetch = realFetch;
  resetEnv();

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  process.exit(failed ? 1 : 0);
})();
