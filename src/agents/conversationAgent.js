/**
 * CONVERSATION AGENT — the personal companion the user actually talks
 * to. Every turn that isn't clearly a specialist's job lands here.
 *
 * Personal: her system prompt is assembled PER USER, per turn — the
 * user's name and gender from the account, plus everything the memory
 * store has learned across conversations.
 *
 * Human: layered speaking directives make replies sound like a person
 * on a call — contractions, small reactions, one thought at a time,
 * remembering what was said a minute ago — not a search engine reading
 * results. (The base prompt already handles language matching, safety
 * and TTS constraints; this adds the humanity on top.)
 */
const { one } = require("../db");
const { generateReply } = require("../services/ai/router");
const memory = require("./memory");

const HUMAN_DIRECTIVE =
  "\n\nHOW YOU SPEAK (very important): You sound like a warm, quick-witted " +
  "human friend on a phone call, never like a machine. Use natural " +
  "contractions. React briefly and genuinely to what the user says before " +
  "answering ('Oh nice!', 'Ayyo, that sounds stressful') when it fits — at " +
  "most a few words, and not on every turn. One thought at a time; short " +
  "sentences with natural rhythm. Refer back to things from earlier in the " +
  "conversation and from what you remember about the user, the way a friend " +
  "who knows them would. Occasionally ask a short, caring follow-up question " +
  "when the moment invites it — never more than one. If you don't know " +
  "something, say so simply and warmly. Never say you are an AI, a model, or " +
  "an assistant program unless the user directly asks — and if they do ask, " +
  "answer honestly and lightly, then move on.";

/**
 * The per-user personalization block — also exported for the D-ID face
 * bridge so the photoreal face knows the same person.
 */
async function personaBlock(userId) {
  let who = "";
  if (userId) {
    try {
      const u = await one(`SELECT name, gender FROM users WHERE id=$1`, [userId]);
      if (u?.name) {
        who =
          `\n\nTHIS USER: their name is ${u.name}` +
          (u.gender ? `, they are ${u.gender}` : "") +
          ". Use their name naturally sometimes — the way a friend does, " +
          "not in every sentence.";
      }
    } catch (_) {}
  }
  const mem = await memory.memoryBlock(userId);
  return HUMAN_DIRECTIVE + who + mem;
}

/**
 * @param {{history:Array, userId:number|null, toolBlock:string, styleBlock:string}} turn
 */
async function handle(turn) {
  const { history, userId, toolBlock = "", styleBlock = "" } = turn;
  const extraSystem = (await personaBlock(userId)) + toolBlock + styleBlock;
  const { reply } = await generateReply(history, { extraSystem });

  // Learn from this turn AFTER the reply (fire-and-forget, zero latency).
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (lastUser) memory.extractAndStore(userId, lastUser.content);

  return { text: reply || "Sorry, say that once more?", used: [] };
}

module.exports = { handle, personaBlock };
