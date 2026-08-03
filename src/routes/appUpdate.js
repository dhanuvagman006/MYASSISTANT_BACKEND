/**
 * SELF-HOSTED APP UPDATES (sideload / client-testing distribution)
 * ----------------------------------------------------------------
 * While the app is distributed as a direct APK (pre-Play-Store), the
 * backend is the update channel:
 *
 *   POST /admin/apk      (X-Admin-Key, multipart)  — upload a new build
 *   GET  /app/latest.apk (public)                  — download the newest APK
 *   GET  /config                                   — now carries apkUrl,
 *                        apkSha256 and the uploaded build's version info,
 *                        so installed apps see the update immediately.
 *
 * Uploads land in DATA_DIR/apk/ (the persistent volume), alongside a
 * latest.json metadata file. Only the newest build is kept — each upload
 * deletes the previous APK to cap disk use.
 *
 * ⚠️ Remove/disable this channel for Play Store builds: stores forbid
 * self-updating outside their billing/update systems.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const router = require("express").Router();

const APK_DIR = path.join(
  process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"),
  "apk"
);
const META = path.join(APK_DIR, "latest.json");

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META, "utf8"));
  } catch {
    return null; // no build uploaded yet
  }
}

function writeMeta(meta) {
  fs.mkdirSync(APK_DIR, { recursive: true });
  fs.writeFileSync(META, JSON.stringify(meta, null, 2));
}

/** Called from the admin upload route after multer stored the temp file. */
async function publish({ tmpPath, versionCode, versionName, changelog }) {
  fs.mkdirSync(APK_DIR, { recursive: true });

  // Hash while it's still a temp file, then move into place atomically.
  const sha256 = await new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(tmpPath)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

  const filename = `hari-${versionCode}.apk`;
  const finalPath = path.join(APK_DIR, filename);
  fs.renameSync(tmpPath, finalPath);

  // Drop the previous build (keep exactly one on disk).
  const prev = readMeta();
  if (prev?.filename && prev.filename !== filename) {
    fs.rmSync(path.join(APK_DIR, prev.filename), { force: true });
  }

  const meta = {
    versionCode,
    versionName,
    changelog,
    filename,
    sha256,
    size: fs.statSync(finalPath).size,
    uploadedAt: new Date().toISOString(),
  };
  writeMeta(meta);
  return meta;
}

// ---- public download ----
router.get("/latest.apk", (_req, res) => {
  const meta = readMeta();
  if (!meta) return res.status(404).json({ error: "no build published" });
  const file = path.join(APK_DIR, meta.filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "apk missing" });
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.setHeader("Content-Disposition", `attachment; filename="${meta.filename}"`);
  res.setHeader("X-Version-Code", String(meta.versionCode));
  res.sendFile(file);
});

module.exports = { router, readMeta, publish, APK_DIR };
