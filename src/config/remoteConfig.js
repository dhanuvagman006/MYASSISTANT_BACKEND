/**
 * THE UPDATE SWITCHBOARD
 * ----------------------
 * Edit this file and redeploy (or later, move it to a database with an
 * admin panel) and every installed app picks up the change on next
 * launch — no Play Store release, no rebuild.
 *
 * Use it to:
 *  - announce new AI capabilities the moment they ship server-side
 *  - flip feature flags for screens already built into the app
 *  - prompt (or force) a Play Store update when a new APK is released
 */
module.exports = {
  latestVersionCode: 1,
  latestVersionName: "0.1.0",
  forceUpdateBelow: 0, // set to a versionCode to force-update older installs

  changelog: [
    "First internal build — chat with live AI",
  ],

  announcement: null,

  // Rebuild-from-scratch reset: every removed feature is OFF so installed
  // apps hide their entry points. Flip back only when a feature returns.
  features: {
    voice_mode: true,         // speak in -> spoken reply out (Gemini)
    morning_briefing: false,
    face_mode: false,
    face_interview: false,
    video_briefing: false,
    photo_questions: true,    // photos/receipts via /vision + /docs
    live_info_cards: false,
    agent_calls: false,
  },
};
