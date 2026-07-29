/**
 * AGENT CALL ENGINE — the brain that talks ON the phone call.
 *
 * Three jobs, each with a deterministic fallback so a dead AI provider
 * never strands a live phone call:
 *   openingLine  — what Hari says when the contact picks up
 *   nextTurn     — given what the contact just said, decide what to say
 *                  next and whether the goal is met (then hang up politely)
 *   summarize    — after hangup, one spoken sentence answering the user
 *
 * Every AI response is strict JSON, re-validated before use. The call is
 * hard-capped at MAX_TURNS agent turns so a chatty contact (or a model
 * loop) can never run up the phone bill.
 */
const { generateReply } = require("../services/ai/router");

const MAX_TURNS = 6;

const CALL_SYSTEM =
  "You are 'Hari', a polite AI assistant making a REAL PHONE CALL on behalf " +
  "of your user. You are talking to the user's contact, NOT to the user. " +
  "Be brief, warm and natural — one or two short spoken sentences per turn, " +
  "no lists, no emojis, no markdown. Never reveal private information about " +
  "the user beyond what the task requires. Never agree to commitments, " +
  "payments or personal data requests on the user's behalf — say you will " +
  "pass the message along instead. Speak in the language of the task.";

function fmtTranscript(transcript) {
  return transcript
    .map((t) => `${t.who === "agent" ? "You (Hari)" : "Contact"}: ${t.text}`)
    .join("\n");
}

/** Parse a JSON object out of a model reply that may have prose around it. */
function extractJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (_) {
    return null;
  }
}

async function openingLine(call, userName) {
  const who = userName || "your friend";
  const fallback =
    `Hello! This is Hari, ${who}'s assistant, calling on their behalf. ` +
    `${call.task.trim().replace(/[.?!]*$/, "")}?`;
  try {
    const { reply } = await generateReply(
      [
        {
          role: "user",
          content:
            `You just called ${call.contact_name}. Your user's name is "${who}". ` +
            `The task: "${call.task}". Greet the contact, say who you are and who ` +
            `you're calling for, and ask the question (or deliver the message) in ` +
            `one natural breath. Reply with ONLY the spoken line, nothing else.`,
        },
      ],
      { system: CALL_SYSTEM }
    );
    const line = String(reply || "").trim();
    return line && line.length < 500 ? line : fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * @returns {{say: string, done: boolean}}
 */
async function nextTurn(call, heard) {
  const agentTurns = call.transcript.filter((t) => t.who === "agent").length;
  const mustEnd = agentTurns >= MAX_TURNS;
  const fallback = {
    say: "Thank you so much, I'll pass that along. Have a great day, goodbye!",
    done: true,
  };
  if (mustEnd) return fallback;
  try {
    const { reply } = await generateReply(
      [
        {
          role: "user",
          content:
            `Task from your user: "${call.task}".\n` +
            `Conversation so far:\n${fmtTranscript(call.transcript)}\n` +
            `The contact just said: "${heard}".\n\n` +
            `Decide your next move. If the task is fulfilled (you got the answer ` +
            `or delivered the message), thank them, say goodbye, and set done=true. ` +
            `If their reply was unclear or incomplete, ask ONE short clarifying ` +
            `question and set done=false. If they ask who you are, answer honestly. ` +
            `Respond with ONLY strict JSON: {"say": "<spoken line>", "done": true|false}`,
        },
      ],
      { system: CALL_SYSTEM }
    );
    const j = extractJson(reply);
    if (j && typeof j.say === "string" && j.say.trim()) {
      return { say: j.say.trim().slice(0, 500), done: Boolean(j.done) };
    }
    return fallback;
  } catch (_) {
    return fallback;
  }
}

/** One or two sentences the app SPEAKS to the user afterwards. */
async function summarize(call) {
  const saidByContact = call.transcript
    .filter((t) => t.who === "contact" && t.text.trim())
    .map((t) => t.text.trim());
  const fallback = saidByContact.length
    ? `I spoke with ${call.contact_name}. They said: ${saidByContact.join(" ")}`
    : `I reached ${call.contact_name}, but I couldn't get a clear answer.`;
  try {
    const { reply } = await generateReply(
      [
        {
          role: "user",
          content:
            `You called ${call.contact_name} for your user with this task: ` +
            `"${call.task}".\nFull call transcript:\n${fmtTranscript(call.transcript)}\n\n` +
            `Now report back TO YOUR USER (not the contact) in one or two short ` +
            `spoken sentences: what did ${call.contact_name} say / what's the answer? ` +
            `Reply with ONLY the spoken report, nothing else.`,
        },
      ],
      {
        system:
          "You are Hari, a voice assistant reporting a phone call's outcome to " +
          "your user. Plain speech only — no markdown, no emojis, 1-2 sentences.",
      }
    );
    const line = String(reply || "").trim();
    return line && line.length < 600 ? line : fallback;
  } catch (_) {
    return fallback;
  }
}

module.exports = { openingLine, nextTurn, summarize, MAX_TURNS };
