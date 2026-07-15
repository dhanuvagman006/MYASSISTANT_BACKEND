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

  announcement: null, // e.g. "New: Malayalam voice replies are live! 🎉"

  features: {
    voice_mode: false,        // A2 — flip when voice ships
    morning_briefing: false,  // C2
    photo_questions: false,   // B1
    live_info_cards: false,   // A5 structured answer cards
  },
};
