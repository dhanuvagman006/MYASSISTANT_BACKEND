/**
 * AGENT ORCHESTRATOR — one entry point per user turn.
 *
 *   turn text ──► route() ──► booking / search / conversation agent
 *                              │
 *                              └─► { text, agent, used[] }
 *
 * Routing is deterministic keyword matching, checked in priority order —
 * fast (zero extra model calls), predictable, and debuggable. Anything
 * the specialists don't claim flows to the conversation agent, so there
 * is never a dead turn.
 *
 * The caller (assistant/routes.js runTurn) turns `agent` + `used` into
 * tool_started/tool_completed events, so the app shows live cards like
 * "Search agent · reading today's headlines…".
 *
 * Adding an agent = new file in src/agents with { matches, handle } and
 * one line in AGENTS below. (The "call <name>" phone flow stays in
 * assistant/routes.js because it needs the device round-trip.)
 */
const bookingAgent = require("./bookingAgent");
const searchAgent = require("./searchAgent");
const conversationAgent = require("./conversationAgent");
const memory = require("./memory");

/** Priority order: most specific first. */
const AGENTS = [
  { name: "booking", label: "Booking agent", mod: bookingAgent },
  { name: "search", label: "Search agent", mod: searchAgent },
];

function route(text) {
  for (const a of AGENTS) {
    try {
      if (a.mod.matches(text)) return a;
    } catch (_) {}
  }
  return { name: "conversation", label: "Hari", mod: conversationAgent };
}

/**
 * Run one full turn.
 * @param {{
 *   text:string, history:Array, userId:number|null,
 *   tzOffsetMin:number, lat?:number, lng?:number,
 *   toolBlock?:string, styleBlock?:string,
 * }} turn
 * @returns {Promise<{text:string, agent:string, agentLabel:string,
 *                    used:Array<{tool:string,label:string}>}>}
 */
async function runAgentTurn(turn) {
  const agent = route(turn.text);
  const out = await agent.mod.handle({
    ...turn,
    // Specialists get the personalization too — the booking agent
    // confirming "your usual place" should know the user like she does.
    styleBlock: turn.styleBlock || "",
    toolBlock: turn.toolBlock || "",
  });

  // Specialist turns still feed the memory (e.g. "book my ANNIVERSARY
  // dinner" teaches us the anniversary matters), asynchronously.
  if (agent.name !== "conversation") {
    memory.extractAndStore(turn.userId, turn.text);
  }

  return {
    text: out.text,
    agent: agent.name,
    agentLabel: agent.label,
    used: out.used || [],
  };
}

module.exports = { runAgentTurn, route };
