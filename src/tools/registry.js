/**
 * TOOL REGISTRY — the extensible capability layer for the agent runtime.
 *
 * Before this, capabilities were selected by ~8 hard-coded regex functions
 * inside a 750-line route (detectCallIntent, detectVideoMode, …). Adding a
 * capability meant editing that route and inventing another regex, and any
 * phrasing the regex didn't anticipate simply didn't work.
 *
 * Now every capability is a Tool with a declared schema. The MODEL chooses
 * which to call (Gemini function-calling), so "find me somewhere to eat
 * near here" and "any good dosa places around?" both reach the same tool
 * without a single new pattern.
 *
 *   Tool {
 *     name            unique id the model calls
 *     description     what it does / when to use it (the model reads this)
 *     inputSchema     JSON-schema-ish; becomes the function declaration
 *     risk            "low" | "medium" | "high"   (see permissions)
 *     deviceAction    true if the PHONE must perform it, not the server
 *     execute(args, ctx) -> { ok, data?, error?, speak? }
 *   }
 *
 * risk drives confirmation (§17):
 *   low     search, weather, memory reads          — run immediately
 *   medium  create reminder, save document         — run immediately
 *   high    place a call, send a message, delete    — confirm first
 *
 * deviceAction tools never "succeed" on the server: they return an action
 * for the app to perform, and the app reports the real result (§7/§27) —
 * the backend must never claim it dialled a phone it cannot dial.
 */

const REGISTRY = new Map();

/** Registers a tool. Throws on duplicate/invalid — fail at boot, not in a turn. */
function register(tool) {
  if (!tool || typeof tool.name !== "string" || !tool.name) {
    throw new Error("tool: name required");
  }
  if (typeof tool.execute !== "function") {
    throw new Error(`tool ${tool.name}: execute() required`);
  }
  if (!["low", "medium", "high"].includes(tool.risk || "low")) {
    throw new Error(`tool ${tool.name}: invalid risk "${tool.risk}"`);
  }
  if (REGISTRY.has(tool.name)) {
    throw new Error(`tool ${tool.name}: already registered`);
  }
  REGISTRY.set(tool.name, {
    risk: "low",
    deviceAction: false,
    inputSchema: { type: "object", properties: {} },
    ...tool,
  });
  return tool.name;
}

function get(name) {
  return REGISTRY.get(name) || null;
}

function list() {
  return [...REGISTRY.values()];
}

/**
 * Gemini functionDeclarations for the registered tools.
 * `only` optionally restricts the set (e.g. a channel that can't do device
 * actions shouldn't be offered them).
 */
function declarations({ only = null, includeDeviceActions = true } = {}) {
  return list()
    .filter((t) => (only ? only.includes(t.name) : true))
    .filter((t) => (includeDeviceActions ? true : !t.deviceAction))
    .map((t) => ({
      name: t.name,
      description: t.description || "",
      parameters: normalizeSchema(t.inputSchema),
    }));
}

/** Gemini wants uppercase JSON-schema types and no unsupported keywords. */
function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "OBJECT", properties: {} };
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "type" && typeof v === "string") out.type = v.toUpperCase();
    else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([pk, pv]) => [pk, normalizeSchema(pv)])
      );
    } else if (k === "items") out.items = normalizeSchema(v);
    else if (["description", "required", "enum", "format"].includes(k)) out[k] = v;
    // anything else (additionalProperties, $schema, default…) is dropped:
    // Gemini rejects unknown fields in a declaration.
  }
  if (!out.type) out.type = "OBJECT";
  if (out.type === "OBJECT" && !out.properties) out.properties = {};
  return out;
}

/** Coerces model-supplied args to the declared types; drops unknown keys. */
function coerceArgs(tool, raw) {
  const props = (tool.inputSchema && tool.inputSchema.properties) || {};
  const args = {};
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in (raw || {}))) continue;
    let v = raw[key];
    const t = String(spec.type || "string").toLowerCase();
    if (t === "number" || t === "integer") {
      const n = Number(v);
      if (Number.isFinite(n)) args[key] = t === "integer" ? Math.trunc(n) : n;
    } else if (t === "boolean") {
      args[key] = v === true || v === "true";
    } else if (t === "array") {
      args[key] = Array.isArray(v) ? v : [v];
    } else if (t === "object") {
      if (v && typeof v === "object") args[key] = v;
    } else {
      if (v !== null && v !== undefined) args[key] = String(v);
    }
  }
  return args;
}

/** Missing required args, so the agent can ask instead of failing. */
function missingRequired(tool, args) {
  const req = (tool.inputSchema && tool.inputSchema.required) || [];
  return req.filter(
    (k) => args[k] === undefined || args[k] === null || args[k] === ""
  );
}

/**
 * Executes a tool by name.
 *
 * Returns a RESULT ENVELOPE, never throws:
 *   { ok:true,  data, speak? }
 *   { ok:false, error }                       real failure, reported honestly
 *   { ok:false, needsArgs:[…] }               agent should ask the user
 *   { ok:false, needsConfirmation:true, … }   high-risk, awaiting yes/no
 *   { ok:true,  deviceAction:{…} }            the APP must perform it
 */
async function execute(name, rawArgs, ctx = {}) {
  const tool = get(name);
  if (!tool) return { ok: false, error: `unknown tool "${name}"` };

  const args = coerceArgs(tool, rawArgs);
  const missing = missingRequired(tool, args);
  if (missing.length) return { ok: false, needsArgs: missing };

  // High-risk actions need explicit approval unless it has already been
  // granted for THIS call (the confirm endpoint replays with approved:true).
  if (tool.risk === "high" && !ctx.approved) {
    return {
      ok: false,
      needsConfirmation: true,
      tool: name,
      args,
      summary: tool.confirmSummary ? tool.confirmSummary(args, ctx) : name,
    };
  }

  const started = Date.now();
  try {
    const out = await tool.execute(args, ctx);
    const res = out && typeof out === "object" ? out : { ok: true, data: out };
    res.ms = Date.now() - started;
    return res;
  } catch (e) {
    // §28: report the actual failure; never fabricate success.
    return {
      ok: false,
      error: String((e && e.message) || e).slice(0, 300),
      ms: Date.now() - started,
    };
  }
}

module.exports = {
  register,
  get,
  list,
  declarations,
  execute,
  coerceArgs,
  missingRequired,
  normalizeSchema,
  _clear: () => REGISTRY.clear(), // tests only
};
