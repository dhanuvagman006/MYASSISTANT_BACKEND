/**
 * CLIENT / PATIENT MODE TESTS — `node scripts/clients-test.js`
 *
 * Verifies professional mode end-to-end with a STUBBED DB and AI — no
 * Postgres, no keys, no network. Covers:
 *   • clients/store: create, fuzzy voice-name matching, notes, doc links
 *   • intents: case-file recall block + on-screen documents,
 *     "note for patient X: …" deterministic write, auto-create on first
 *     mention, ambiguity handling, client list, and that the generic
 *     document search is SKIPPED when a client turn already ran.
 *
 * Exit 0 = all pass; non-zero prints the failures.
 */
process.env.DATA_DIR = "/tmp/hari-clients-test";

const Module = require("module");
const orig = Module.prototype.require;

/* ------------------------- in-memory "Postgres" ------------------------- */
const db = { clients: [], notes: [], documents: [], audits: [] };
let cId = 0, nId = 0;

const fakeDb = {
  async one(q, p) {
    if (q.includes("COUNT(*)::int AS n FROM clients"))
      return { n: db.clients.filter((c) => c.user_id === p[0]).length };
    if (q.includes("INSERT INTO clients")) {
      const row = {
        id: ++cId, user_id: p[0], name: p[1], kind: p[2], phone: p[3],
        email: p[4], summary: p[5], tags: p[6], created_at: p[7], updated_at: p[7],
      };
      db.clients.push(row);
      return { ...row };
    }
    if (q.includes("FROM clients WHERE id"))
      return db.clients.find((c) => c.id === p[0] && c.user_id === p[1]) || null;
    if (q.includes("INSERT INTO client_notes")) {
      const row = { id: ++nId, user_id: p[0], client_id: p[1], text: p[2], created_at: p[3] };
      db.notes.push(row);
      return { ...row };
    }
    if (q.includes("COUNT(*)::int AS n FROM documents"))
      return { n: db.documents.filter((d) => d.user_id === p[0]).length };
    if (q.includes("FROM documents WHERE id"))
      return db.documents.find((d) => d.id === p[0] && d.user_id === p[1]) || null;
    return null;
  },
  async query(q, p) {
    if (q.includes("FROM clients WHERE user_id"))
      return db.clients
        .filter((c) => c.user_id === p[0])
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, p[1]);
    if (q.includes("FROM client_notes WHERE user_id"))
      return db.notes
        .filter((n) => n.user_id === p[0] && n.client_id === p[1])
        .sort((a, b) => b.id - a.id)
        .slice(0, p[2]);
    if (q.includes("FROM documents WHERE user_id = $1 AND client_id"))
      return db.documents.filter((d) => d.user_id === p[0] && d.client_id === p[1]).slice(0, p[2]);
    return [];
  },
  async run(q, p) {
    if (q.startsWith("UPDATE clients SET name")) {
      const c = db.clients.find((x) => x.id === p[7] && x.user_id === p[8]);
      if (!c) return 0;
      [c.name, c.kind, c.phone, c.email, c.summary, c.tags, c.updated_at] = p;
      return 1;
    }
    if (q.startsWith("UPDATE clients SET updated_at")) {
      const c = db.clients.find((x) => x.id === p[1] && x.user_id === p[2]);
      if (c) c.updated_at = p[0];
      return c ? 1 : 0;
    }
    if (q.includes("DELETE FROM client_notes WHERE client_id")) {
      const before = db.notes.length;
      db.notes = db.notes.filter((n) => !(n.client_id === p[0] && n.user_id === p[1]));
      return before - db.notes.length;
    }
    if (q.includes("DELETE FROM client_notes WHERE id")) {
      const before = db.notes.length;
      db.notes = db.notes.filter(
        (n) => !(n.id === p[0] && n.client_id === p[1] && n.user_id === p[2])
      );
      return before - db.notes.length;
    }
    if (q.includes("DELETE FROM clients")) {
      const before = db.clients.length;
      db.clients = db.clients.filter((c) => !(c.id === p[0] && c.user_id === p[1]));
      return before - db.clients.length;
    }
    if (q.includes("UPDATE documents SET client_id = NULL WHERE client_id")) {
      let n = 0;
      for (const d of db.documents)
        if (d.client_id === p[0] && d.user_id === p[1]) { d.client_id = null; n++; }
      return n;
    }
    if (q.includes("UPDATE documents SET client_id")) {
      const d = db.documents.find((x) => x.id === p[1] && x.user_id === p[2]);
      if (!d) return 0;
      d.client_id = p[0];
      return 1;
    }
    return 0;
  },
};

Module.prototype.require = function (id) {
  if (id.endsWith("/db") || id === "../db" || id === "../../db") return fakeDb;
  if (/audit\/log$/.test(id))
    return { record: (u, a, d) => db.audits.push({ a, d }) };
  if (/services\/ai\/router$/.test(id))
    return {
      generateReply: async () => ({ reply: "ok" }),
      generateReplyStream: async function* () { yield "ok"; },
      transcribeAudio: async () => ({ text: "" }),
    };
  if (/tools\/(weather|news|places|currency|units)$/.test(id))
    return {
      getWeather: async () => null, describe: () => "",
      getHeadlines: async () => [], searchPlaces: async () => [], describePlaces: () => "",
      parseCurrencyAsk: () => null, getRate: async () => 1,
      parseUnitAsk: () => null, convert: () => null, parseConversion: () => null,
      parseAndConvert: () => null,
    };
  if (/google\/tokens$/.test(id)) return { isConnected: async () => false };
  if (/google\/api$/.test(id)) return {};
  if (/reminders\/store$/.test(id)) return { create: async () => null, listOpen: async () => [] };
  return orig.apply(this, arguments);
};

/* ------------------------------- harness ------------------------------- */
const failures = [];
function check(name, cond) {
  if (cond) console.log("  ✓ " + name);
  else { console.error("  ✗ " + name); failures.push(name); }
}

(async () => {
  const store = require("../src/clients/store");
  const { buildToolContext } = require("../src/services/intents");
  const U = 1;

  console.log("clients/store …");
  const ramesh = await store.createClient(U, {
    name: "Ramesh Gowda", kind: "patient", summary: "42M, type-2 diabetic",
  });
  const sharma = await store.createClient(U, { name: "Anil Sharma", kind: "client" });
  check("create returns rows", ramesh.id > 0 && sharma.id > 0);

  await store.addNote(U, ramesh.id, "Allergic to penicillin");
  await store.addNote(U, ramesh.id, "BP 140/90 on 10 Aug, increased metformin");
  check("notes stored newest-first",
    (await store.listNotes(U, ramesh.id))[0].text.includes("BP 140/90"));

  db.documents.push({
    id: 1, user_id: U, client_id: null, filename: "r.pdf", mime: "application/pdf",
    size: 10, path: "/tmp/x", title: "Blood Report", category: "medical",
    doc_date: "2026-08-10", summary: "HbA1c 7.9", note: "", tags: "",
    full_text: "HbA1c 7.9 percent. Fasting glucose 140.", created_at: Date.now(),
  });
  check("link document", await store.linkDocument(U, 1, ramesh.id));
  check("linked doc listed", (await store.listClientDocuments(U, ramesh.id)).length === 1);

  const m1 = await store.findByName(U, "pull up patient Ramesh Gowda's file please");
  check("fuzzy full-name match wins", m1[0]?.client.id === ramesh.id && m1[0].score >= 80);
  const m2 = await store.findByName(U, "details about Sharma");
  check("single-word surname match", m2[0]?.client.id === sharma.id);
  check("no false match", (await store.findByName(U, "weather in Mysuru")).length === 0);

  console.log("intents — case-file recall …");
  const turn = (text) =>
    buildToolContext({ userId: U, messages: [{ role: "user", content: text }], tzOffsetMin: 330 });

  let r = await turn("give me the details about patient Ramesh Gowda");
  check("recall block built", r.block.includes('CASE FILE of patient "Ramesh Gowda"'));
  check("notes in block", r.block.includes("Allergic to penicillin"));
  check("doc full text in block", r.block.includes("HbA1c 7.9 percent"));
  check("documents surfaced on screen", r.documents.length === 1 && r.documents[0].title === "Blood Report");
  check("recall audited", db.audits.some((x) => x.a === "client.viewed"));

  r = await turn("show me patient Ramesh Gowda's reports");
  check("doc-recall skipped when client handled",
    r.block.includes("CASE FILE") && !r.block.includes("MATCHING SAVED DOCUMENTS"));

  console.log("intents — voice notes …");
  r = await turn("note for patient Ramesh Gowda: started insulin today");
  check("note write confirmed", r.block.includes("CLIENT NOTE SAVED"));
  check("note text stored",
    (await store.listNotes(U, ramesh.id))[0].text === "started insulin today");

  r = await turn("note for patient Lakshmi: BP under control");
  const lakshmi = db.clients.find((c) => c.name === "Lakshmi");
  check("unknown name auto-creates the patient", !!lakshmi && lakshmi.kind === "patient");
  check("auto-created card got the note",
    lakshmi && (await store.listNotes(U, lakshmi.id))[0]?.text === "BP under control");

  await store.createClient(U, { name: "Ramesh Iyer", kind: "patient" });
  r = await turn("note for patient Ramesh: follow up next week");
  check("ambiguous name saves nothing, asks instead",
    r.block.includes("more than one person") || r.block.includes("NO note was saved"));

  console.log("intents — list + regressions …");
  r = await turn("who are my patients?");
  check("list includes everyone",
    r.block.includes("Ramesh Gowda") && r.block.includes("Lakshmi") && r.block.includes("Anil Sharma"));

  r = await turn("hello how are you today");
  check("plain chat untouched", !/CASE FILE|CLIENT NOTE|clients\/patients/.test(r.block));

  console.log("clients/store — delete keeps documents …");
  await store.deleteClient(U, ramesh.id);
  check("client gone", !(await store.getClient(U, ramesh.id)));
  check("document survives, unlinked",
    db.documents[0] && db.documents[0].client_id === null);

  if (failures.length) {
    console.error(`\n${failures.length} FAILED`);
    process.exit(1);
  }
  console.log("\nAll client-mode tests passed.");
})().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
