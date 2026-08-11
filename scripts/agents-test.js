/**
 * AGENT TESTS — `node scripts/agents-test.js`
 *
 * Verifies the multi-agent system end-to-end with STUBBED AI and DB —
 * no Postgres, no GEMINI_API_KEY, no network needed. Covers the spec's
 * verification case ("who is the PM?" must route to the search agent)
 * plus routing, booking, memory and personalization.
 *
 * Exit 0 = all pass; non-zero prints the failures.
 */
const Module = require("module");
const orig = Module.prototype.require;

const db = { memories: [], bookings: [], reminders: [] };
let bookingId = 0;

Module.prototype.require = function (id) {
  if (/services\/ai\/router$/.test(id) || id === "../services/ai/router") {
    return {
      generateReply: async (msgs, opts = {}) => {
        const sys = opts.system || "";
        if (sys.includes("extract durable personal facts"))
          return { reply: '[{"fact":"User\'s name is Test","importance":3}]' };
        if (sys.includes("Extract booking details"))
          return { reply: '{"kind":"restaurant","title":"Table","venue":"Cafe","party_size":2}' };
        const extra = opts.extraSystem || "";
        return {
          reply:
            "R[mem=" + extra.includes("WHAT YOU REMEMBER") +
            ",search=" + extra.includes("SEARCH AGENT") +
            ",live=" + extra.includes("LIVE KNOWLEDGE") + "]",
        };
      },
      generateReplyStream: async function* () { yield "x"; },
      transcribeAudio: async () => ({ text: "hi" }),
    };
  }
  if (/services\/intents$/.test(id)) return { buildToolContext: async () => ({ block: "", sources: [] }) };
  if (/tools\/news$/.test(id)) return { getHeadlines: async () => [{ title: "T", source: "S" }] };
  if (/tools\/places$/.test(id)) return { searchPlaces: async () => [], describePlaces: () => "" };
  if (/tools\/weather$/.test(id)) return { getWeather: async () => null, describe: () => "" };
  if (id.endsWith("/db") || id === "../db") {
    return {
      query: async (q, p) => (q.includes("agent_memories") ? db.memories.filter((m) => m.u === p[0]) : []),
      one: async (q, p) => {
        if (q.includes("SELECT id FROM agent_memories"))
          return db.memories.find((m) => m.u === p[0] && m.fact.toLowerCase() === p[1].toLowerCase()) || null;
        if (q.includes("INSERT INTO bookings")) { const r = { id: ++bookingId }; db.bookings.push(r); return r; }
        if (q.includes("SELECT name, gender FROM users")) return { name: "Test", gender: "male" };
        return null;
      },
      run: async (q, p) => {
        if (q.includes("INSERT INTO agent_memories")) db.memories.push({ u: p[0], fact: p[1] });
        if (q.includes("INSERT INTO reminders")) db.reminders.push(p[1]);
        return 1;
      },
    };
  }
  return orig.apply(this, arguments);
};

// The live-knowledge fetches must not hit the real network in tests.
global.fetch = async () => ({
  ok: true,
  json: async () => ({ Answer: "Live answer from lookup" }),
});

const assert = (name, cond) => {
  results.push([name, !!cond]);
};
const results = [];

(async () => {
  const { route, runAgentTurn } = require("../src/agents/orchestrator");

  // 1. Routing
  assert("'who is the pm of india' → search", route("who is the pm of india").name === "search");
  assert("'book a table tomorrow' → booking", route("book a table tomorrow").name === "booking");
  assert("'i am feeling great' → conversation", route("i am feeling great").name === "conversation");
  assert("'any news about isro' → search", route("any news about isro").name === "search");

  const base = { userId: 1, tzOffsetMin: 330, toolBlock: "" };

  // 2. Search agent grounds factual questions in the live lookup
  let t = await runAgentTurn({ ...base, text: "who is the prime minister of india", history: [{ role: "user", content: "who is the prime minister of india" }] });
  assert("PM question handled by search agent", t.agent === "search");
  assert("PM answer grounded in live lookup", t.text.includes("live=true"));

  // 3. Conversation agent learns + personalizes
  await runAgentTurn({ ...base, text: "my name is Test", history: [{ role: "user", content: "my name is Test" }] });
  await new Promise((r) => setTimeout(r, 50)); // async extraction
  assert("memory extracted", db.memories.length > 0);
  t = await runAgentTurn({ ...base, text: "how are you", history: [{ role: "user", content: "how are you" }] });
  assert("next turn is personalized", t.text.includes("mem=true"));

  // 4. Booking agent writes the ledger + reminder
  t = await runAgentTurn({ ...base, text: "book a table for two tomorrow at 8pm", history: [] });
  assert("booking created", /Booked/.test(t.text));
  assert("reminder attached", db.reminders.length === 1);

  // Report
  let fail = 0;
  for (const [name, ok] of results) {
    console.log((ok ? "  PASS " : "✗ FAIL ") + name);
    if (!ok) fail++;
  }
  console.log(fail === 0 ? "\nAll agent tests passed." : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("test crash:", e);
  process.exit(1);
});
