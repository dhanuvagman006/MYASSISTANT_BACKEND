/**
 * AGENT RUNTIME — the decision-making layer (§37).
 *
 * Replaces the regex chain in assistant/routes.js. One loop handles every
 * request, whatever the channel (voice, text, live, avatar):
 *
 *   context → model reasons over TOOL DECLARATIONS → executes chosen tools
 *   → feeds results back → model composes the spoken answer
 *
 * The model decides. There is no per-capability `if` here, which is the
 * whole point: a phrasing nobody anticipated still routes correctly.
 *
 * Honest by construction (§27/§28):
 *   • a failed tool is reported as failed, in the reply
 *   • a device action is described as STARTING, never as completed
 *   • a high-risk action pauses for confirmation before running
 */
const registry = require("../tools/registry");
const { registerBuiltins } = require("../tools/builtins");
const { generateWithTools } = require("../services/ai/router");

registerBuiltins();

const MAX_TOOL_ROUNDS = 3; // guards against a tool-calling loop

function systemPrompt(extra = "") {
  return (
    "You are Hari, a warm, quick-witted personal assistant from India. " +
    "You are having a SPOKEN conversation, so keep replies short and natural " +
    "— one or two sentences unless asked for detail. Reply in whatever " +
    "language the user speaks (English, Kannada, Hindi or a mix).\n\n" +
    "You have tools. Use them whenever the answer depends on current " +
    "information, the user's stored data, or an action on their phone. " +
    "Never guess at something a tool can tell you.\n\n" +
    "CRITICAL HONESTY RULES:\n" +
    "- If a tool fails, say plainly what failed. Never pretend it worked.\n" +
    "- Phone calls and camera open ON THE USER'S DEVICE. Say you are " +
    "starting it, never that it is done.\n" +
    "- If you need a detail to run a tool (a city, a date, a name), ask one " +
    "short question instead of guessing.\n" +
    extra
  );
}

/**
 * Runs one turn.
 *
 * @param {string} userText   what the user said
 * @param {object} ctx        { userId, city, lat, lng, history[], approved,
 *                              pendingCall }
 * @param {function} onEvent  optional progress hook: ("tool_start"|"tool_done", payload)
 * @returns {{ text, deviceActions[], toolResults[], needsConfirmation? }}
 */
async function runAgentTurn(userText, ctx = {}, onEvent = () => {}) {
  // Built-ins plus ONLY this user's MCP tools (§6). One selection path for
  // both sources — the runtime does not know MCP exists (§1).
  const declarations = registry.declarations({ userId: ctx.userId });
  const contents = [];

  // Short conversation context (§18) — recent turns only, never the whole
  // lifetime history.
  for (const m of (ctx.history || []).slice(-8)) {
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "") }],
    });
  }
  contents.push({ role: "user", parts: [{ text: userText }] });

  const deviceActions = [];
  const toolResults = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const out = await generateWithTools({
      contents,
      system: systemPrompt(ctx.extraSystem || ""),
      declarations,
    });

    if (!out.functionCalls.length) {
      return {
        text: out.text || "",
        deviceActions,
        toolResults,
      };
    }

    // Record the model's tool calls so the follow-up request has them.
    contents.push({
      role: "model",
      parts: out.functionCalls.map((c) => ({
        functionCall: { name: c.name, args: c.args },
      })),
    });

    const responseParts = [];
    for (const call of out.functionCalls) {
      onEvent("tool_start", { name: call.name, args: call.args });
      const res = await registry.execute(call.name, call.args, ctx);
      toolResults.push({ name: call.name, ...res });
      onEvent("tool_done", { name: call.name, ok: res.ok });

      // High-risk: stop the whole turn and ask the user first (§17).
      if (res.needsConfirmation) {
        return {
          text: "",
          needsConfirmation: {
            tool: res.tool,
            args: res.args,
            summary: res.summary,
          },
          deviceActions,
          toolResults,
        };
      }
      if (res.deviceAction) deviceActions.push(res.deviceAction);

      // What the model sees: a compact, TRUTHFUL result.
      const payload = res.ok
        ? { ok: true, result: res.speak || res.data || "done" }
        : res.needsArgs
          ? { ok: false, missing: res.needsArgs }
          : { ok: false, error: res.error || "failed" };

      responseParts.push({
        functionResponse: { name: call.name, response: payload },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  // Ran out of rounds — answer with whatever the tools produced rather
  // than looping forever.
  const last = toolResults[toolResults.length - 1];
  return {
    text: last && last.speak ? last.speak : "",
    deviceActions,
    toolResults,
  };
}

module.exports = { runAgentTurn, systemPrompt };
