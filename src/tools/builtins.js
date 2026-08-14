/**
 * BUILT-IN TOOLS — existing capabilities, exposed to the agent runtime.
 *
 * Every tool here WRAPS a module that already worked (weather, news,
 * places, currency, reminders, documents, people, calls). Nothing is
 * reimplemented and nothing is faked: if an integration is missing, the
 * tool says so honestly rather than returning a pretend result (§28).
 */
const registry = require("./registry");

const weather = require("../services/tools/weather");
const news = require("../services/tools/news");
const places = require("../services/tools/places");
const currency = require("../services/tools/currency");
const reminders = require("../reminders/store");
const memory = require("../agents/memory");
const docs = require("../docs/store");
const people = require("../clients/store");

let registered = false;

function registerBuiltins() {
  if (registered) return; // idempotent: tests and boot both call this
  registered = true;

  // ---------------- INFORMATION (low risk) ----------------

  registry.register({
    name: "get_weather",
    description:
      "Current weather and short forecast for a city or the user's area. " +
      "Use whenever the user asks about weather, rain, temperature or what to wear.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City name. Omit to use the user's current area.",
        },
      },
    },
    async execute(args, ctx) {
      const where = args.location || ctx.city || "";
      const w = await weather.getWeather(where);
      if (!w) return { ok: false, error: "weather service returned nothing" };
      return { ok: true, data: w, speak: weather.describe(w) };
    },
  });

  registry.register({
    name: "get_news",
    description:
      "Latest news headlines, optionally about a topic, company or person. " +
      "Use for anything current: today's news, what's happening with X.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Subject to search, e.g. 'NVIDIA'. Omit for top headlines.",
        },
      },
    },
    async execute(args) {
      const items = await news.getHeadlines({ topic: args.topic });
      if (!items || !items.length) {
        return { ok: false, error: "no headlines found" };
      }
      return { ok: true, data: items, speak: news.describe(items, args.topic) };
    },
  });

  registry.register({
    name: "search_places",
    description:
      "Find nearby places: restaurants, hospitals, ATMs, shops, petrol pumps. " +
      "Returns names, distance, rating and phone where available.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, e.g. 'dosa restaurant'" },
      },
      required: ["query"],
    },
    async execute(args, ctx) {
      const list = await places.searchPlaces({
        q: args.query,
        lat: ctx.lat,
        lng: ctx.lng,
      });
      if (!list || !list.length) return { ok: false, error: "no places found" };
      return { ok: true, data: list, speak: places.describePlaces(list) };
    },
  });

  registry.register({
    name: "convert_currency",
    description: "Convert an amount between currencies at the current rate.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount to convert" },
        from: { type: "string", description: "3-letter code, e.g. USD" },
        to: { type: "string", description: "3-letter code, e.g. INR" },
      },
      required: ["amount", "from", "to"],
    },
    async execute(args) {
      const rate = await currency.getRate(
        String(args.from).toUpperCase(),
        String(args.to).toUpperCase()
      );
      if (!rate) return { ok: false, error: "rate unavailable" };
      const value = args.amount * rate;
      return {
        ok: true,
        data: { rate, value },
        speak: `${args.amount} ${args.from.toUpperCase()} is about ${value.toFixed(2)} ${args.to.toUpperCase()}.`,
      };
    },
  });

  // ---------------- MEMORY ----------------

  registry.register({
    name: "remember_fact",
    description:
      "Store a durable fact about the user or their life so it is remembered " +
      "in future conversations (preferences, family, work, important dates).",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The fact, in third person: 'prefers Kannada'" },
        importance: { type: "integer", description: "1-5, default 3" },
      },
      required: ["fact"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      await memory.saveMemory(ctx.userId, args.fact, args.importance || 3);
      return { ok: true, data: { saved: args.fact }, speak: "I'll remember that." };
    },
  });

  registry.register({
    name: "recall_memory",
    description:
      "Look up what is remembered about the user. Use when asked 'what do you " +
      "know about me', or when personal context would improve the answer.",
    risk: "low",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const list = await memory.listMemories(ctx.userId);
      return { ok: true, data: list };
    },
  });

  // ---------------- PEOPLE (clients/contacts the user told us about) ------

  registry.register({
    name: "lookup_person",
    description:
      "Retrieve everything stored about a person the user has told us about " +
      "(relationship, organisation, notes, linked documents). Use for " +
      "'what do you know about Ravi', 'tell me about my client X'.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Person's name" } },
      required: ["name"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const found = await people.findByName(ctx.userId, args.name);
      if (!found) return { ok: false, error: `no stored details for ${args.name}` };
      const profile = await people.getProfile(ctx.userId, found.id);
      return { ok: true, data: profile };
    },
  });

  registry.register({
    name: "list_person_documents",
    description:
      "List documents linked to a person, e.g. 'show me Ravi's documents'.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Person's name" } },
      required: ["name"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const found = await people.findByName(ctx.userId, args.name);
      if (!found) return { ok: false, error: `no person named ${args.name}` };
      const list = await people.listClientDocuments(ctx.userId, found.id);
      return { ok: true, data: list };
    },
  });

  // ---------------- DOCUMENTS ----------------

  registry.register({
    name: "search_documents",
    description:
      "Search the user's saved documents (receipts, reports, notices) by text.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for" } },
      required: ["query"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const list = await docs.searchDocuments(ctx.userId, args.query);
      if (!list || !list.length) return { ok: false, error: "no matching documents" };
      return { ok: true, data: list.map(docs.toClient) };
    },
  });

  // ---------------- PRODUCTIVITY ----------------

  registry.register({
    name: "create_reminder",
    description:
      "Create a reminder or task for the user, optionally with a due time.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to be reminded of" },
        due_at: {
          type: "string",
          description: "ISO-8601 datetime, or omit if no specific time",
        },
      },
      required: ["text"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const due = args.due_at ? new Date(args.due_at) : null;
      const r = await reminders.create(
        ctx.userId,
        args.text,
        due && !isNaN(due.getTime()) ? due.toISOString() : null
      );
      if (!r) return { ok: false, error: "could not save the reminder" };
      return { ok: true, data: r, speak: "Saved." };
    },
  });

  registry.register({
    name: "list_reminders",
    description: "List the user's upcoming reminders and tasks.",
    risk: "low",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const list = await reminders.list(ctx.userId);
      return { ok: true, data: list };
    },
  });

  // ---------------- DEVICE ACTIONS ----------------
  // These CANNOT be performed by the server. Android/iOS require the app to
  // initiate them, so the tool returns an authorized action for the app and
  // the app reports the real outcome. The agent must never claim success.

  registry.register({
    name: "place_phone_call",
    description:
      "Call one of the user's contacts from their phone. Use for 'call mom', " +
      "'ring Ravi'. The call is dialled on the user's device.",
    risk: "high",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Contact name to call" },
        message: {
          type: "string",
          description: "Optional message the user wants passed on",
        },
      },
      required: ["name"],
    },
    confirmSummary: (a) =>
      a.message ? `Call ${a.name} and say: ${a.message}` : `Call ${a.name}`,
    async execute(args) {
      return {
        ok: true,
        deviceAction: {
          type: "resolve_and_call",
          name: args.name,
          message: args.message || null,
        },
        // Deliberately NOT "I called them" — the device hasn't dialled yet.
        speak: `Calling ${args.name}…`,
      };
    },
  });

  registry.register({
    name: "open_camera",
    description:
      "Open the camera on the user's phone to capture a document or photo, " +
      "e.g. 'save this receipt', 'scan this notice'.",
    risk: "medium",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "What the user is capturing" },
      },
    },
    async execute(args) {
      return {
        ok: true,
        deviceAction: { type: "open_camera", note: args.note || null },
        speak: "Opening the camera.",
      };
    },
  });

  registry.register({
    name: "open_video_mode",
    description:
      "Switch to the face-to-face video avatar conversation. Use only when " +
      "the user asks for video/face mode — NOT for calling a contact.",
    risk: "medium",
    deviceAction: true,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return {
        ok: true,
        deviceAction: { type: "open_video" },
        speak: "Opening video mode.",
      };
    },
  });

  // ---------------- WEB SEARCH (interface defined, key required) ----------

  registry.register({
    name: "web_search",
    description:
      "Search the live web for current information the assistant would not " +
      "otherwise know: today's events, prices, company news, facts that change.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
    async execute(args) {
      const search = require("./webSearch");
      return search.run(args.query);
    },
  });
}

module.exports = { registerBuiltins };
