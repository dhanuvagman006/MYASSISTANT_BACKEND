/**
 * SMOKE TEST — booted by `npm test` and by CI on every push/PR.
 * Starts the real server with a throwaway DB and checks the endpoints a
 * broken commit is most likely to kill. Exits 1 (failing CI) on any error.
 * No AI keys needed: everything tested here is deterministic.
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

async function req(method, url, { body, token } = {}) {
  const r = await fetch(BASE + url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, json };
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-smoke-"));
  const server = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      JWT_SECRET: "smoke-test-secret-smoke-test-secret-123",
      GROQ_API_KEY: "", GEMINI_API_KEY: "", SARVAM_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (d) => (logs += d));
  server.stderr.on("data", (d) => (logs += d));

  try {
    // Wait for boot.
    let up = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const h = await req("GET", "/health");
        if (h.status === 200 && h.json?.ok) { up = true; break; }
      } catch (_) {}
      if (server.exitCode !== null) break;
    }
    assert(up, "server did not boot. Logs:\n" + logs);

    // Auth
    const su = await req("POST", "/auth/signup", {
      body: { email: "smoke@test.com", password: "password123", name: "Smoke Test" },
    });
    assert(su.status === 200 && su.json?.token, "/auth/signup " + su.status);
    assert(su.json.isNew === true, "signup should report isNew");
    const token = su.json.token;

    const li = await req("POST", "/auth/login", {
      body: { email: "smoke@test.com", password: "password123" },
    });
    assert(li.status === 200 && li.json?.isNew === false, "/auth/login");

    // Memory (seeded at signup + CRUD)
    const mem = await req("GET", "/memory", { token });
    assert(mem.status === 200 && mem.json.memories.length >= 2, "memory seeding");
    const add = await req("POST", "/memory", {
      token, body: { key: "smoke_key", value: "smoke value", category: "fact" },
    });
    assert(add.status === 200, "/memory add");

    // Reminders CRUD
    const cr = await req("POST", "/reminders", {
      token, body: { text: "smoke reminder", dueAt: Date.now() + 3600_000 },
    });
    assert(cr.status === 200 && cr.json.reminder?.id, "/reminders create");
    const list = await req("GET", "/reminders", { token });
    assert(list.status === 200 && list.json.reminders.length === 1, "/reminders list");
    const del = await req("DELETE", `/reminders/${cr.json.reminder.id}`, { token });
    assert(del.status === 200, "/reminders delete");

    // Google link: correct unlinked behaviour
    const gs = await req("GET", "/google/status", { token });
    assert(gs.status === 200 && gs.json.connected === false, "/google/status");
    const gi = await req("GET", "/google/inbox", { token });
    assert(gi.status === 409, "/google/inbox should 409 when unlinked");

    // Auth is actually enforced
    const noauth = await req("GET", "/memory");
    assert(noauth.status === 401, "unauthenticated /memory should 401");

    console.log("SMOKE TEST PASSED ✔");
  } finally {
    server.kill("SIGKILL");
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
