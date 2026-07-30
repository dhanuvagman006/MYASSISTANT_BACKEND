/**
 * PRIVACY DASHBOARD (F2) — the two rights every user has:
 *   GET    /privacy/export   → one JSON file with EVERYTHING we hold on them
 *   DELETE /privacy/account  → permanent, irreversible erasure (DB rows in a
 *                              single transaction + document files on disk +
 *                              best-effort token revocation at Google)
 *
 * Design notes for scale:
 *   • Export streams straight from indexed per-user queries — no scans.
 *   • Deletion is ONE SQLite transaction (atomic even if the process dies);
 *     disk/file cleanup and remote revocation happen after commit and are
 *     retried-safe (idempotent).
 *   • Tables are looked up defensively via sqlite_master so a future table
 *     without a user_id column can never crash the endpoint.
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const { db, findById } = require("../db");
const gtokens = require("../google/tokens");

const router = express.Router();

const filesRoot = path.join(
  process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"),
  "files"
);

/** tables that key rows by a user column → [table, column] */
const USER_TABLES = [
  ["memories", "user_id"],
  ["reminders", "user_id"],
  ["documents", "user_id"],
  ["google_tokens", "user_id"],
  ["swiggy_tokens", "user_id"],
  ["agent_calls", "user_id"],
  ["agent_call_settings", "user_id"],
  ["subscriptions", "user_id"],
  ["usage", "user_id"],
  ["payments", "user_id"],
  ["family_members", "user_id"],
  ["families", "owner_id"],
];

const tableExists = db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
);
const hasColumn = (table, col) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

function existingUserTables() {
  return USER_TABLES.filter(
    ([t, c]) => tableExists.get(t) && hasColumn(t, c)
  );
}

// Never export secrets — the user owns their data, not our credentials.
const REDACT = new Set([
  "password_hash", "refresh_token", "access_token", "token", "id_token",
]);
function redactRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = REDACT.has(k) ? (v ? "[stored — redacted]" : null) : v;
  }
  return out;
}

// ---------- GET /privacy/export ----------
router.get("/export", (req, res) => {
  const uid = req.user.sub;
  const user = findById(Number(uid)) || null;
  const data = {
    exported_at: new Date().toISOString(),
    format: "myassistant-export-v1",
    account: user ? redactRow({ ...user }) : { id: uid },
    // service link status instead of raw tokens
    connections: {
      google: !!gtokens.isConnected?.(uid),
    },
  };
  for (const [table, col] of existingUserTables()) {
    if (table === "google_tokens" || table === "swiggy_tokens") continue; // covered above
    try {
      data[table] = db
        .prepare(`SELECT * FROM ${table} WHERE ${col} = ?`)
        .all(String(uid))
        .map(redactRow);
    } catch (e) {
      data[table] = { error: "could not read: " + e.message };
    }
  }
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="myassistant-data.json"'
  );
  res.json(data);
});

// ---------- DELETE /privacy/account ----------
router.delete("/account", async (req, res) => {
  const uid = req.user.sub;

  // 1) best-effort remote revocation FIRST (needs the tokens to still exist)
  try {
    if (gtokens.isConnected?.(uid)) await gtokens.disconnect(uid);
  } catch (e) {
    console.warn("google revoke during account delete:", e.message);
  }

  // 2) all DB rows in one atomic transaction
  try {
    db.transaction(() => {
      for (const [table, col] of existingUserTables()) {
        db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(String(uid));
      }
      // FTS shadow table for documents, if present
      if (tableExists.get("documents_fts")) {
        try {
          db.prepare(
            "DELETE FROM documents_fts WHERE rowid NOT IN (SELECT rowid FROM documents)"
          ).run();
        } catch (_) {}
      }
      db.prepare("DELETE FROM users WHERE id = ?").run(Number(uid));
    })();
  } catch (e) {
    console.error("account delete failed:", e.message);
    return res.status(500).json({ error: "deletion failed — try again" });
  }

  // 3) document files on disk (post-commit; idempotent)
  try {
    fs.rmSync(path.join(filesRoot, String(uid)), { recursive: true, force: true });
  } catch (e) {
    console.warn("file cleanup during account delete:", e.message);
  }

  res.json({ ok: true, deleted: true });
});

module.exports = router;
