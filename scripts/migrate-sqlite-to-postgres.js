/**
 * ONE-TIME DATA MIGRATION: SQLite (myassistant.db) → Postgres.
 *
 * Copies every user, reminder, memory, token, call, billing row and
 * document into Postgres, preserving ids (so JWTs and doc file paths
 * keep working). Idempotent: rows that already exist are skipped.
 *
 * Usage (better-sqlite3 was removed from dependencies, install it just
 * for this run):
 *
 *   npm i better-sqlite3 --no-save
 *   DATABASE_URL=postgres://... SQLITE_PATH=./data/myassistant.db \
 *     node scripts/migrate-sqlite-to-postgres.js
 *
 * On Kubernetes, run it from your laptop with both ports forwarded, or
 * copy the .db file out of the old PVC first:
 *   kubectl -n myassistant cp <old-pod>:/app/data/myassistant.db ./myassistant.db
 */
const path = require("path");

async function main() {
  const sqlitePath =
    process.env.SQLITE_PATH ||
    path.join(process.env.DATA_DIR || "./data", "myassistant.db");
  const Database = require("better-sqlite3");
  const src = new Database(sqlitePath, { readonly: true });
  const db = require("../src/db");
  await db.init();

  const has = (t) =>
    src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const all = (t) => (has(t) ? src.prepare(`SELECT * FROM ${t}`).all() : []);
  let total = 0;

  const copy = async (table, rows, cols, conflict) => {
    for (const r of rows) {
      const vals = cols.map((c) => (r[c] === undefined ? null : r[c]));
      const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
      const n = await db.run(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph})
         ON CONFLICT (${conflict}) DO NOTHING`,
        vals
      );
      total += n;
    }
    console.log(`  ${table}: ${rows.length} rows read`);
  };

  console.log(`Migrating from ${sqlitePath} …`);
  await copy("users", all("users"),
    ["id", "email", "name", "password_hash", "provider", "provider_sub", "created_at"], "id");
  await copy("reminders", all("reminders"),
    ["id", "user_id", "text", "due_at", "done", "created_at"], "id");
  await copy("memories", all("memories"),
    ["id", "user_id", "category", "key", "value", "source", "created_at", "updated_at"], "id");
  await copy("google_tokens", all("google_tokens"),
    ["user_id", "refresh_token", "access_token", "expires_at", "scopes", "updated_at"], "user_id");
  await copy("swiggy_tokens", all("swiggy_tokens"),
    ["user_id", "refresh_token", "access_token", "expires_at", "updated_at"], "user_id");
  await copy("kv", all("kv"), ["k", "v"], "k");
  await copy("agent_calls", all("agent_calls"),
    ["id", "user_id", "contact_name", "to_number", "task", "lang", "state",
     "transcript", "result", "provider_call_id", "created_at", "updated_at"], "id");
  await copy("agent_call_settings", all("agent_call_settings"),
    ["user_id", "enabled", "daily_limit", "hours_start", "hours_end"], "user_id");
  await copy("subscriptions", all("subscriptions"),
    ["user_id", "plan", "period_end", "last_payment", "updated_at"], "user_id");
  await copy("usage", all("usage"), ["user_id", "kind", "period", "count"], "user_id, kind, period");
  await copy("families", all("families"), ["id", "owner_id", "code", "created_at"], "id");
  await copy("family_members", all("family_members"),
    ["family_id", "user_id", "joined_at"], "user_id");
  await copy("payments", all("payments"),
    ["payment_id", "user_id", "plan", "amount", "created_at"], "payment_id");
  await copy("documents", all("documents"),
    ["id", "user_id", "filename", "mime", "size", "path", "title", "category",
     "doc_date", "summary", "note", "tags", "full_text", "created_at"], "id");

  // SERIAL sequences must jump past the imported ids or the next INSERT
  // would collide with a migrated row.
  for (const [t, col] of [["users", "id"], ["reminders", "id"], ["memories", "id"], ["families", "id"], ["documents", "id"]]) {
    await db.query(
      `SELECT setval(pg_get_serial_sequence('${t}', '${col}'),
        GREATEST((SELECT COALESCE(MAX(${col}), 0) FROM ${t}), 1))`
    );
  }

  console.log(`Done — ${total} rows inserted (already-present rows skipped).`);
  await db.close();
}

main().catch((e) => {
  console.error("MIGRATION FAILED:", e.message);
  process.exit(1);
});
