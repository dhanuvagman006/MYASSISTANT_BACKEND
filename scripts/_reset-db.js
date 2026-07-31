/**
 * Test-only DB reset — restores the "fresh database every run" semantics
 * the suite had with SQLite (where each run started from a new file).
 * Refuses to run against a production database.
 */
module.exports.resetDb = async function resetDb() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("_reset-db must never run in production");
  }
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
  );
  if (rows.length) {
    await pool.query(
      "TRUNCATE " + rows.map((r) => `"${r.table_name}"`).join(", ") + " RESTART IDENTITY CASCADE"
    );
  }
  await pool.end();
};
