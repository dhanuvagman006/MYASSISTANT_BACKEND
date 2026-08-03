const router = require("express").Router();
const remoteConfig = require("../config/remoteConfig");
const appUpdate = require("./appUpdate");

// Static switchboard (feature flags, announcements) merged with the
// dynamically uploaded APK metadata — an APK published via POST /admin/apk
// overrides the hardcoded version fields, so shipping an update is just
// one curl, no redeploy.
router.get("/", (_req, res) => {
  const apk = appUpdate.readMeta();
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  res.json({
    ...remoteConfig,
    ...(apk && {
      latestVersionCode: apk.versionCode,
      latestVersionName: apk.versionName,
      changelog: apk.changelog?.length ? apk.changelog : remoteConfig.changelog,
      apkUrl: base ? `${base}/app/latest.apk` : null,
      apkSha256: apk.sha256,
      apkSize: apk.size,
    }),
  });
});

module.exports = router;
