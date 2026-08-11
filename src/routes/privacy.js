/**
 * PRIVACY DASHBOARD (F2) — the two rights every user has:
 *   GET    /privacy/export   → one JSON file with EVERYTHING we hold on them
 *   DELETE /privacy/account  → permanent, irreversible erasure (DB rows in a
 *                              single transaction + document files on disk +
 *                              best-effort token revocation at Google)
 *
 * Design notes for scale:
 *   • Export streams straight from indexed per-user queries — no scans.
 *   • Deletion is ONE Postgres transaction (atomic even if the process dies);
 *     disk/file cleanup and remote revocation happen after commit and are
 *     retried-safe (idempotent).
 *   • Tables are looked up defensively via information_schema so a future table
 *     without a user_id column can never crash the endpoint.
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const { query, one, run, tx, findById } = require("../db");
const gtokens = require("../google/tokens");

const router = express.Router();

const filesRoot = path.join(
  process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"),
  "files"
);

/** tables that key rows by a user column → [table, column] */
const USER_TABLES = [
  ["actions_log", "user_id"],
  ["reminders", "user_id"],
  ["documents", "user_id"],
  ["google_tokens", "user_id"],
  ["agent_memories", "user_id"], // everything the assistant remembers
  ["bookings", "user_id"], // the booking agent's ledger
];

async function existingUserTables() {
  const rows = await query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'`
  );
  const cols = new Set(rows.map((r) => r.table_name + "." + r.column_name));
  return USER_TABLES.filter(([t, c]) => cols.has(t + "." + c));
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
router.get("/export", async (req, res) => {
  const uid = req.user.sub;
  const user = (await findById(Number(uid))) || null;
  const data = {
    exported_at: new Date().toISOString(),
    format: "myassistant-export-v1",
    account: user ? redactRow({ ...user }) : { id: uid },
    // service link status instead of raw tokens
    connections: {
      google: !!(await gtokens.isConnected?.(uid)),
    },
  };
  for (const [table, col] of await existingUserTables()) {
    if (table === "google_tokens" || table === "swiggy_tokens") continue; // covered above
    try {
      // table/col come from OUR whitelist above (never user input) and were
      // verified against information_schema — safe to interpolate.
      data[table] = (
        await query(`SELECT * FROM ${table} WHERE ${col} = $1`, [String(uid)])
      ).map(redactRow);
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
    if (await gtokens.isConnected?.(uid)) await gtokens.disconnect(uid);
  } catch (e) {
    console.warn("google revoke during account delete:", e.message);
  }

  // 2) all DB rows in one atomic transaction
  // (No FTS shadow table anymore — the Postgres tsvector column lives on
  //  the documents rows and dies with them.)
  try {
    const tables = await existingUserTables();
    await tx(async (client) => {
      for (const [table, col] of tables) {
        await client.query(`DELETE FROM ${table} WHERE ${col} = $1`, [String(uid)]);
      }
      await client.query("DELETE FROM users WHERE id = $1", [Number(uid)]);
    });
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
