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
        about: { type: "string", description: "Person this fact concerns, if any" },
        importance: { type: "integer", description: "1-5, default 3" },
      },
      required: ["fact"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      let subjectType = "", subjectId = null;
      if (args.about) {
        const p = await mem.findPerson(ctx.userId, args.about);
        if (p) { subjectType = "person"; subjectId = p.id; }
      }
      await mem.remember(ctx.userId, {
        fact: args.fact,
        importance: args.importance || 3,
        subjectType, subjectId,
      });
      return { ok: true, data: { saved: args.fact }, speak: "I'll remember that." };
    },
  });

  registry.register({
    name: "recall_memory",
    description:
      "Look up what is remembered about the user or a topic. Use when asked " +
      "'what do you know about me', 'what did I tell you about X', or when " +
      "personal context would improve the answer.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to recall about" } },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (args.query) {
        const r = await mem.search(ctx.userId, args.query);
        return { ok: true, data: r };
      }
      const list = await memory.listMemories(ctx.userId);
      return { ok: true, data: list };
    },
  });

  // ---------------- PEOPLE (clients/contacts the user told us about) ------

  const mem = require("../memory/service");

  registry.register({
    name: "remember_person",
    description:
      "Record or update a PERSON the user tells you about — their name, how " +
      "they relate to the user (client, patient, friend, colleague), their " +
      "organisation and location. Use for 'Ravi is my client', 'my doctor is " +
      "Dr Rao at Manipal'.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Person's name" },
        relationship: { type: "string", description: "client, patient, friend, wife, colleague…" },
        organisation: { type: "string", description: "Company or institution" },
        location: { type: "string", description: "City or place" },
      },
      required: ["name"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const p = await mem.upsertPerson(ctx.userId, args);
      return { ok: true, data: { id: p.id, name: p.name }, speak: "Noted." };
    },
  });

  registry.register({
    name: "remember_case",
    description:
      "Record a CASE, matter or project — a legal case, medical record, " +
      "business project or personal matter — and optionally attach a person " +
      "to it. Use for 'his case is a property dispute in Mangalore'.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, e.g. 'Property dispute'" },
        person: { type: "string", description: "Person this case belongs to" },
        description: { type: "string" },
        location: { type: "string" },
        status: { type: "string", description: "open, closed, on_hold" },
      },
      required: ["title"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      let personId = null;
      if (args.person) {
        const p = await mem.upsertPerson(ctx.userId, { name: args.person });
        personId = p.id;
      }
      const c = await mem.upsertCase(ctx.userId, { ...args, personId });
      return { ok: true, data: { id: c.id, title: c.title }, speak: "Got it." };
    },
  });

  registry.register({
    name: "remember_event",
    description:
      "Record a dated event tied to a person or case — a hearing, meeting, " +
      "appointment or deadline. Use for \'Ravi\'s next hearing is on September 3\'.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the event is" },
        when: { type: "string", description: "ISO-8601 date/time if known" },
        person: { type: "string", description: "Person it relates to" },
        case_title: { type: "string", description: "Case it relates to" },
      },
      required: ["title"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      let subjectType = "", subjectId = null;
      if (args.person) {
        const p = await mem.upsertPerson(ctx.userId, { name: args.person });
        subjectType = "person"; subjectId = p.id;
      }
      const when = args.when ? Date.parse(args.when) : NaN;
      const e = await mem.addEvent(ctx.userId, {
        title: args.title,
        whenAt: Number.isFinite(when) ? when : null,
        subjectType, subjectId,
      });
      // Also store as a retrievable fact so plain recall finds it.
      if (subjectId) {
        await mem.remember(ctx.userId, {
          fact: args.when ? `${args.title} on ${args.when}` : args.title,
          kind: "episodic", subjectType, subjectId, importance: 4,
        });
      }
      return { ok: true, data: { id: e.id }, speak: "I'll remember that." };
    },
  });

  registry.register({
    name: "forget_memory",
    description:
      "Delete or correct something previously remembered, when the user says " +
      "it is wrong or asks you to forget it. Use for 'forget Ravi\'s hearing " +
      "date', 'Ravi is not my client anymore'.",
    risk: "high",
    inputSchema: {
      type: "object",
      properties: {
        about: { type: "string", description: "Person or case it concerns" },
        what: { type: "string", description: "What to forget, e.g. 'hearing date'" },
      },
      required: ["what"],
    },
    confirmSummary: (a) =>
      a.about ? `Forget ${a.about}'s ${a.what}` : `Forget: ${a.what}`,
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      let subjectType = "", subjectId = null;
      if (args.about) {
        const p = await mem.findPerson(ctx.userId, args.about);
        if (p) { subjectType = "person"; subjectId = p.id; }
      }
      const n = await mem.forget(ctx.userId, { subjectType, subjectId, match: args.what });
      if (!n) return { ok: false, error: "nothing matching was stored" };
      return { ok: true, data: { forgotten: n }, speak: "Forgotten." };
    },
  });

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
      const profile = await mem.recallAbout(ctx.userId, args.name);
      if (!profile) return { ok: false, error: `nothing stored about ${args.name}` };
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
      const found = await mem.findPerson(ctx.userId, args.name);
      if (!found) return { ok: false, error: `no person named ${args.name}` };
      const list = await mem.documentsFor(ctx.userId, "person", found.id);
      const profile = await mem.recallAbout(ctx.userId, args.name);
      const all = profile ? profile.documents : list;
      if (!all.length) return { ok: false, error: `no documents stored for ${args.name}` };
      return { ok: true, data: all };
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
    name: "search_flights",
    description:
      "Find real flights between two cities on a date. Use for 'next flight " +
      "from Bangalore to Delhi', 'flights to Mumbai tomorrow'.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Origin city or 3-letter airport code" },
        to: { type: "string", description: "Destination city or 3-letter airport code" },
        date: { type: "string", description: "Departure date YYYY-MM-DD; omit for tomorrow" },
        adults: { type: "integer", description: "Passengers, default 1" },
      },
      required: ["from", "to"],
    },
    async execute(args) {
      return require("./flights").search(args);
    },
  });

  registry.register({
    name: "find_document",
    description:
      "Find a specific document, optionally belonging to a person — e.g. " +
      "'find Ravi's court notice', 'show me the electricity bill'. Searches " +
      "INSIDE document contents, not just titles.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the document is, e.g. 'court notice'" },
        person: { type: "string", description: "Whose document, if the user named someone" },
      },
      required: ["query"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const intel = require("../docs/intelligence");
      const r = await intel.findDocuments(ctx.userId, args.query, { person: args.person });
      if (!r.found) {
        return {
          ok: false,
          error: r.scope
            ? `no documents for ${r.scope} matching that`
            : "no matching documents",
        };
      }
      return { ok: true, data: r.documents };
    },
  });

  registry.register({
    name: "associate_document",
    description:
      "Link the most recent (or a named) document to a person and/or case — " +
      "'this document belongs to Ravi's case'.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "integer", description: "Omit to use the newest document" },
        person: { type: "string" },
        case_title: { type: "string" },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const intel = require("../docs/intelligence");
      const { one } = require("../db");
      let id = args.document_id;
      if (!id) {
        const latest = await one(
          `SELECT id FROM documents WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
          [ctx.userId]
        );
        if (!latest) return { ok: false, error: "no documents saved yet" };
        id = latest.id;
      }
      const out = await intel.associate(ctx.userId, id, {
        person: args.person || null,
        caseTitle: args.case_title || null,
      });
      if (!out.person && !out.case) {
        return { ok: false, error: "name a person or case to link it to" };
      }
      return { ok: true, data: out, speak: "Linked." };
    },
  });

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

  // ---------------- PROFILE + STANDING RULES ----------------
  const userCtx = require("../users/context");

  registry.register({
    name: "update_my_profile",
    description:
      "Save personal details the user shares about THEMSELVES — profession, " +
      "organisation, location, preferred language, what to call them. Use " +
      "for 'I'm a software engineer at Acme in Mangalore', 'call me Dhanu'.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "What the user wants to be called" },
        profession: { type: "string" },
        organisation: { type: "string" },
        location: { type: "string" },
        preferred_language: { type: "string" },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const p = await userCtx.updateProfile(ctx.userId, args);
      return { ok: true, data: p.user, speak: "Got it." };
    },
  });

  registry.register({
    name: "add_standing_instruction",
    description:
      "Save a PERMANENT rule for how the assistant should behave — 'always " +
      "ask before sending messages', 'you can create reminders without " +
      "asking', 'never call anyone after 10pm'. Use when the user states a " +
      "lasting preference about YOUR behaviour, not a one-off request.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: { instruction: { type: "string", description: "The rule, verbatim" } },
      required: ["instruction"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      await userCtx.addInstruction(ctx.userId, args.instruction);
      return { ok: true, speak: "Understood — I'll always do that." };
    },
  });

  registry.register({
    name: "remove_standing_instruction",
    description:
      "Remove a previously saved behaviour rule when the user cancels it — " +
      "'you don't need to ask before reminders anymore'.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: { about: { type: "string", description: "Words identifying the rule" } },
      required: ["about"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const n = await userCtx.removeInstruction(ctx.userId, args.about);
      if (!n) return { ok: false, error: "no matching rule found" };
      return { ok: true, data: { removed: n }, speak: "Done, rule removed." };
    },
  });

  registry.register({
    name: "configure_assistant",
    description:
      "Change the ASSISTANT's own identity when the user asks — its name " +
      "('I'll call you Maya'), gender presentation, or communication style " +
      "(concise/friendly/formal).",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New assistant name, e.g. Maya" },
        gender: { type: "string", description: "female, male or neutral" },
        style: { type: "string", description: "concise, friendly or formal" },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const a = await userCtx.setAssistantProfile(ctx.userId, args);
      return {
        ok: true,
        data: a,
        speak: args.name ? `From now on I'm ${a.name}.` : "Done.",
      };
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
