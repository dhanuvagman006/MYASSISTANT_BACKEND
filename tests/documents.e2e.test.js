/**
 * PHASE 3 DOCUMENT TESTS (§16, §18) — real PostgreSQL.
 *
 * Proves the pipeline stores chunks, that retrieval is ENTITY-SCOPED
 * rather than a blind global search, that it degrades to lexical ranking
 * with no embedding provider, and that documents stay tenant-isolated.
 */
const assert = require("assert");

process.env.GEMINI_API_KEY = ""; // force the no-embeddings path
process.env.OPENAI_API_KEY = "";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-at-least-32-characters-long!";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:55432/myassistant_test";

const db = require("../src/db");
const mem = require("../src/memory/service");
const intel = require("../src/docs/intelligence");
const registry = require("../src/tools/registry");
require("../src/tools/builtins").registerBuiltins();

let pass = 0, fail = 0;
const QUEUE = [];
const test = (n, f) => QUEUE.push([n, f]);
async function drain() {
  for (const [n, f] of QUEUE) {
    try {
      await f();
      console.log("PASS  " + n);
      pass++;
    } catch (e) {
      console.log("FAIL  " + n + "\n      " + (e.stack || e.message).split("\n").slice(0, 3).join("\n      "));
      fail++;
    }
  }
}

let A, B, RAVI, CASE_ID, NOTICE_ID, BILL_ID;

const NOTICE_TEXT = `IN THE COURT OF THE CIVIL JUDGE, MANGALORE. Suit No. 442 of 2026.
Notice is hereby issued to the respondent in the matter of the property
dispute concerning survey number 12/3, Kadri village. The respondent is
directed to appear before this court on the third day of September 2026.
Failure to appear may result in an ex-parte order. Advocate for the
petitioner: R. Shetty. This notice concerns the boundary wall and the
disputed easement rights over the northern access path.`;

const BILL_TEXT = `MESCOM ELECTRICITY BILL. Consumer number 55123. Billing period
July 2026. Units consumed 240. Amount payable rupees 1,860. Due date 20
August 2026. Please pay before the due date to avoid disconnection.`;

async function setup() {
  await db.init();
  const t = Date.now();
  await db.run(`DELETE FROM document_chunks`);
  await db.run(`DELETE FROM document_links`);
  await db.run(`DELETE FROM documents WHERE filename LIKE 'p3-%'`);
  await db.run(`DELETE FROM users WHERE email LIKE 'p3-%'`);
  A = (await db.one(`INSERT INTO users (email,name,created_at) VALUES ('p3-a@test','A',$1) RETURNING id`, [t])).id;
  B = (await db.one(`INSERT INTO users (email,name,created_at) VALUES ('p3-b@test','B',$1) RETURNING id`, [t])).id;

  const p = await mem.upsertPerson(A, { name: "Ravi", relationship: "client" });
  RAVI = p.id;
  const c = await mem.upsertCase(A, { title: "Property dispute", location: "Mangalore", personId: RAVI });
  CASE_ID = c.id;

  const mk = async (user, file, title, cat, text) =>
    (await db.one(
      `INSERT INTO documents (user_id,filename,mime,size,path,title,category,full_text,created_at)
       VALUES ($1,$2,'application/pdf',1,'/tmp/x',$3,$4,$5,$6) RETURNING id`,
      [user, file, title, cat, text, Date.now()]
    )).id;

  NOTICE_ID = await mk(A, "p3-notice.pdf", "Court notice", "legal", NOTICE_TEXT);
  BILL_ID = await mk(A, "p3-bill.pdf", "Electricity bill", "bill", BILL_TEXT);
  // B owns a document with VERY similar text — a global search would find it.
  await mk(B, "p3-other.pdf", "Court notice", "legal", NOTICE_TEXT);
}

/* ---------------- chunking ---------------- */

test("chunking splits long text without breaking words", () => {
  const long = "word ".repeat(2000);
  const chunks = intel.chunkText(long);
  assert.ok(chunks.length > 1, "split into multiple chunks");
  assert.ok(chunks.every((c) => c.length <= intel.MAX_CHUNK_CHARS + 50), "respects size");
  assert.ok(chunks.every((c) => !/\bwor$|^ord\b/.test(c)), "no mid-word cuts");
});

test("short text stays one chunk; empty text yields none", () => {
  assert.strictEqual(intel.chunkText("A short note.").length, 1);
  assert.strictEqual(intel.chunkText("   ").length, 0);
});

test("indexing stores chunks and is idempotent", async () => {
  const r1 = await intel.indexDocument(A, NOTICE_ID, NOTICE_TEXT);
  assert.ok(r1.chunks >= 1);
  assert.strictEqual(r1.embedded, false, "no provider configured → lexical mode");
  await intel.indexDocument(A, BILL_ID, BILL_TEXT);

  const before = await db.query(
    `SELECT count(*)::int n FROM document_chunks WHERE user_id=$1 AND document_id=$2`, [A, NOTICE_ID]);
  await intel.indexDocument(A, NOTICE_ID, NOTICE_TEXT); // re-index
  const after = await db.query(
    `SELECT count(*)::int n FROM document_chunks WHERE user_id=$1 AND document_id=$2`, [A, NOTICE_ID]);
  assert.strictEqual(after[0].n, before[0].n, "re-indexing replaces, never duplicates");
});

/* ---------------- §18 entity-scoped retrieval ---------------- */

test("§18: 'Ravi's court notice' scopes to Ravi BEFORE searching", async () => {
  await mem.linkDocument(A, NOTICE_ID, "case", CASE_ID); // notice belongs to the case
  const r = await intel.findDocuments(A, "court notice", { person: "Ravi" });
  assert.strictEqual(r.found, true);
  assert.ok(r.scope.startsWith("Ravi"), `scoped to the person, got "${r.scope}"`);
  assert.strictEqual(r.documents[0].id, NOTICE_ID);
  // The bill is the user's but NOT Ravi's — scoping must exclude it.
  assert.ok(!r.documents.some((d) => d.id === BILL_ID), "unrelated document excluded by scope");
});

test("§18: searching inside content works, not just titles", async () => {
  const r = await intel.findDocuments(A, "boundary wall easement", { person: "Ravi" });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.documents[0].id, NOTICE_ID);
  assert.match(r.documents[0].snippet, /boundary wall|easement/i);
});

test("naming a person with no matching documents says so, not a global search", async () => {
  await mem.upsertPerson(A, { name: "Anil", relationship: "client" });
  const r = await intel.findDocuments(A, "court notice", { person: "Anil" });
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.documents.length, 0, "did NOT fall back to the whole library");
});

test("with no person named, it searches the user's library", async () => {
  const r = await intel.findDocuments(A, "electricity units consumed");
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.documents[0].id, BILL_ID);
});

/* ---------------- association ---------------- */

test("associate_document links the newest document to a person and case", async () => {
  const res = await registry.execute(
    "associate_document",
    { person: "Anil", case_title: "Contract dispute" },
    { userId: A }
  );
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.person, "Anil");
  const profile = await mem.recallAbout(A, "Anil");
  assert.strictEqual(profile.cases[0].title, "Contract dispute");
  assert.ok(profile.documents.length >= 1, "document now linked to Anil");
});

/* ---------------- tool surface ---------------- */

test("find_document tool returns scoped results through the registry", async () => {
  const res = await registry.execute("find_document", { query: "court notice", person: "Ravi" }, { userId: A });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data[0].title, "Court notice");
});

test("find_document reports honestly when nothing matches", async () => {
  const res = await registry.execute("find_document", { query: "passport", person: "Ravi" }, { userId: A });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /no documents/);
});

/* ---------------- isolation ---------------- */

test("user B cannot retrieve A's documents despite near-identical text", async () => {
  const r = await intel.findDocuments(B, "boundary wall easement");
  const ids = r.documents.map((d) => d.id);
  assert.ok(!ids.includes(NOTICE_ID), "A's notice not returned to B");
});

test("user B's find_document cannot scope to A's person", async () => {
  const res = await registry.execute("find_document", { query: "notice", person: "Ravi" }, { userId: B });
  assert.strictEqual(res.ok, false);
});

test("chunks are tenant-scoped in SQL", async () => {
  const rows = await db.query(
    `SELECT DISTINCT user_id FROM document_chunks WHERE document_id=$1`, [NOTICE_ID]);
  assert.deepStrictEqual(rows.map((r) => Number(r.user_id)), [A]);
});

test("indexing requires an authenticated user", async () => {
  await assert.rejects(() => intel.indexDocument(null, NOTICE_ID, "x"), /authenticated userId required/);
});

setup()
  .then(drain)
  .then(async () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    await db.close();
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    console.error("SETUP FAILED:", e.stack || e.message);
    process.exit(1);
  });
