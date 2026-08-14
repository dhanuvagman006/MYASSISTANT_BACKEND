/**
 * PHASE 2 END-TO-END TESTS — scenarios A–E from the spec, run against a
 * REAL PostgreSQL database (not mocks). The agent runtime is driven with a
 * stubbed model so tool SELECTION is deterministic; everything below the
 * model — tools, memory service, SQL, isolation — is real.
 *
 * Run:  DATABASE_URL=postgres://… node tests/memory.e2e.test.js
 */
const assert = require("assert");

process.env.GEMINI_API_KEY = "test-key";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:55432/myassistant_test";

const db = require("../src/db");
const mem = require("../src/memory/service");
const registry = require("../src/tools/registry");

let pass = 0, fail = 0;
const QUEUE = [];
const test = (name, fn) => QUEUE.push([name, fn]);

async function drain() {
  for (const [name, fn] of QUEUE) {
    try {
      await fn();
      console.log("PASS  " + name);
      pass++;
    } catch (e) {
      console.log("FAIL  " + name + "\n      " + (e.stack || e.message).split("\n").slice(0, 3).join("\n      "));
      fail++;
    }
  }
}

// Stub the model BEFORE the runtime loads it.
const routerPath = require.resolve("../src/services/ai/router");
const realRouter = require(routerPath);
let SCRIPT = [];
require.cache[routerPath].exports = {
  ...realRouter,
  generateWithTools: async () => SCRIPT.shift() || { functionCalls: [], text: "(done)" },
};
const { runAgentTurn } = require("../src/agents/runtime");

let USER_A, USER_B;

async function setup() {
  await db.init();
  const { one, run } = db;
  await run(`DELETE FROM document_links`);
  await run(`DELETE FROM case_people`);
  await run(`DELETE FROM cases`);
  await run(`DELETE FROM events`);
  await run(`DELETE FROM agent_memories`);
  await run(`DELETE FROM client_notes`);
  await run(`DELETE FROM clients`);
  await run(`DELETE FROM documents`);
  await run(`DELETE FROM users WHERE email LIKE 'e2e-%'`);
  const t = Date.now();
  USER_A = (await one(
    `INSERT INTO users (email,name,created_at) VALUES ('e2e-a@test','A',$1) RETURNING id`, [t]
  )).id;
  USER_B = (await one(
    `INSERT INTO users (email,name,created_at) VALUES ('e2e-b@test','B',$1) RETURNING id`, [t]
  )).id;
}

/* ---------------- SCENARIO A: person + case, then recall -------------- */

test("A: 'Ravi is my client, property dispute in Mangalore' is stored structurally", async () => {
  SCRIPT = [
    {
      functionCalls: [
        { name: "remember_person", args: { name: "Ravi", relationship: "client" } },
        { name: "remember_case", args: { title: "Property dispute", person: "Ravi", location: "Mangalore" } },
      ],
      text: "",
    },
    { functionCalls: [], text: "Noted." },
  ];
  const r = await runAgentTurn(
    "Ravi is my client. His case is a property dispute in Mangalore.",
    { userId: USER_A }
  );
  assert.ok(r.toolResults.every((t) => t.ok), "tools succeeded");

  const p = await mem.findPerson(USER_A, "Ravi");
  assert.ok(p, "person row created");
  assert.strictEqual(p.relationship, "client");
  const cases = await mem.casesForPerson(USER_A, p.id);
  assert.strictEqual(cases.length, 1);
  assert.strictEqual(cases[0].location, "Mangalore");
});

test("A: 'What do you know about Ravi?' returns the structured record", async () => {
  const res = await registry.execute("lookup_person", { name: "Ravi" }, { userId: USER_A });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.person.relationship, "client");
  assert.strictEqual(res.data.cases[0].title, "Property dispute");
  assert.strictEqual(res.data.cases[0].location, "Mangalore");
});

/* ---------------- SCENARIO B: document association -------------------- */

test("B: a document linked to Ravi's case is returned for 'Ravi's documents'", async () => {
  const doc = await db.one(
    `INSERT INTO documents (user_id,filename,mime,size,path,title,category,created_at)
     VALUES ($1,'notice.pdf','application/pdf',100,'/tmp/notice.pdf','Court notice','legal',$2)
     RETURNING *`,
    [USER_A, Date.now()]
  );
  const p = await mem.findPerson(USER_A, "Ravi");
  const [c] = await mem.casesForPerson(USER_A, p.id);
  // Linked to the CASE only — it must still surface as Ravi's document.
  await mem.linkDocument(USER_A, doc.id, "case", c.id);

  const res = await registry.execute("list_person_documents", { name: "Ravi" }, { userId: USER_A });
  assert.strictEqual(res.ok, true);
  assert.ok(res.data.some((d) => d.title === "Court notice"), "case document surfaced for the person");
});

test("B: a document may belong to MANY entities", async () => {
  const doc = await db.one(`SELECT id FROM documents WHERE user_id=$1 LIMIT 1`, [USER_A]);
  const p = await mem.findPerson(USER_A, "Ravi");
  await mem.linkDocument(USER_A, doc.id, "person", p.id); // second link, no error
  const links = await db.query(
    `SELECT entity_type FROM document_links WHERE user_id=$1 AND document_id=$2 ORDER BY entity_type`,
    [USER_A, doc.id]
  );
  assert.deepStrictEqual(links.map((l) => l.entity_type), ["case", "person"]);
});

/* ---------------- SCENARIO C: dated fact recall ----------------------- */

test("C: 'Ravi's next hearing is on September 3' is stored and recalled", async () => {
  SCRIPT = [
    {
      functionCalls: [{
        name: "remember_event",
        args: { title: "Next hearing", when: "2026-09-03", person: "Ravi" },
      }],
      text: "",
    },
    { functionCalls: [], text: "Noted." },
  ];
  await runAgentTurn("Remember that Ravi's next hearing is on September 3.", { userId: USER_A });

  const profile = await mem.recallAbout(USER_A, "Ravi");
  assert.ok(profile.events.some((e) => /hearing/i.test(e.title)), "event stored");
  assert.ok(profile.facts.some((f) => /hearing/i.test(f)), "fact retrievable");
});

/* ---------------- SCENARIO D: correction / forgetting ----------------- */

test("D: 'Forget Ravi's hearing date' invalidates it", async () => {
  const res = await registry.execute(
    "forget_memory",
    { about: "Ravi", what: "hearing date" },
    { userId: USER_A, approved: true }
  );
  assert.strictEqual(res.ok, true);

  const profile = await mem.recallAbout(USER_A, "Ravi");
  assert.ok(!profile.facts.some((f) => /hearing/i.test(f)), "hearing fact no longer presented");
});

test("D: forgetting is a soft delete — the row survives for audit", async () => {
  const rows = await db.query(
    `SELECT valid, invalidated_at FROM agent_memories
      WHERE user_id=$1 AND fact ILIKE '%hearing%'`,
    [USER_A]
  );
  assert.ok(rows.length > 0, "row retained");
  assert.ok(rows.every((r) => r.valid === 0 && r.invalidated_at), "marked invalid with timestamp");
});

test("D: forget_memory is high-risk and requires confirmation", async () => {
  const res = await registry.execute("forget_memory", { about: "Ravi", what: "anything" }, { userId: USER_A });
  assert.strictEqual(res.needsConfirmation, true);
});

test("D: a restated attribute supersedes rather than contradicts", async () => {
  const p = await mem.findPerson(USER_A, "Ravi");
  await mem.remember(USER_A, { fact: "address is MG Road", subjectType: "person", subjectId: p.id });
  await mem.remember(USER_A, { fact: "address is Kadri Road", subjectType: "person", subjectId: p.id });
  const profile = await mem.recallAbout(USER_A, "Ravi");
  const addrs = profile.facts.filter((f) => /address/i.test(f));
  assert.strictEqual(addrs.length, 1, `one live address, got ${JSON.stringify(addrs)}`);
  assert.match(addrs[0], /Kadri/);
});

/* ---------------- SCENARIO E: tenant isolation ------------------------ */

test("E: user B cannot see user A's person", async () => {
  const p = await mem.findPerson(USER_B, "Ravi");
  assert.strictEqual(p, null);
});

test("E: user B's lookup_person returns nothing for A's data", async () => {
  const res = await registry.execute("lookup_person", { name: "Ravi" }, { userId: USER_B });
  assert.strictEqual(res.ok, false);
});

test("E: user B cannot see A's documents, facts, cases or events", async () => {
  assert.strictEqual((await mem.documentsFor(USER_B, "person", 1)).length, 0);
  const s = await mem.search(USER_B, "Ravi property dispute");
  assert.strictEqual(s.people.length, 0);
  assert.strictEqual(s.facts.length, 0);
  const cases = await db.query(`SELECT * FROM cases WHERE user_id=$1`, [USER_B]);
  assert.strictEqual(cases.length, 0);
});

test("E: user B cannot link a document they do not own", async () => {
  const doc = await db.one(`SELECT id FROM documents WHERE user_id=$1 LIMIT 1`, [USER_A]);
  await assert.rejects(() => mem.linkDocument(USER_B, doc.id, "person", 1), /document not found/);
});

test("E: user B cannot forget user A's memories", async () => {
  const before = await db.query(
    `SELECT count(*)::int AS n FROM agent_memories WHERE user_id=$1 AND valid=1`, [USER_A]
  );
  await mem.forget(USER_B, { match: "address" });
  const after = await db.query(
    `SELECT count(*)::int AS n FROM agent_memories WHERE user_id=$1 AND valid=1`, [USER_A]
  );
  assert.strictEqual(after[0].n, before[0].n, "A's memories untouched");
});

test("E: a missing userId is a hard failure, never a global read", async () => {
  await assert.rejects(() => mem.recallAbout(null, "Ravi"), /authenticated userId required/);
  await assert.rejects(() => mem.search(undefined, "x"), /authenticated userId required/);
  await assert.rejects(() => mem.remember("", { fact: "x" }), /authenticated userId required/);
});

/* ---------------- retrieval quality ----------------------------------- */

test("recall is hybrid: structured entity match, not vector-only", async () => {
  const r = await mem.search(USER_A, "what did I tell you about Ravi");
  assert.ok(r.people.some((p) => p.name === "Ravi"), "entity matched structurally");
});

test("cosine ranking is correct when embeddings exist", async () => {
  assert.ok(Math.abs(mem.cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(mem.cosine([1, 0], [0, 1])) < 1e-9);
  assert.strictEqual(mem.cosine([1, 0], null), 0);
});

setup()
  .then(drain)
  .then(async () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    await db.close();
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    console.error("SETUP FAILED:", e.message);
    process.exit(1);
  });
