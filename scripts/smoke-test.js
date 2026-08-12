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

let PORT = 0; // assigned in main() via scripts/_free-port.js
let BASE = "";

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
  PORT = await require("./_free-port").freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-smoke-"));
  await require("./_reset-db").resetDb();
  const server = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      JWT_SECRET: "smoke-test-secret-smoke-test-secret-123",
      AUTH_DISABLED: "false", // a local dev .env must never break the suite
      GEMINI_API_KEY: "", SARVAM_API_KEY: "",
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

    // Memory — REPAIRED (Aug 2026): the old key-value /memory API this
    // test used was removed when agent_memories landed; seed via the
    // real survey endpoint and read back through GET /profile.
    const sv = await req("POST", "/profile/survey", {
      token,
      body: { name: "Smoke", location: "Mysuru", preferences: ["cricket"] },
    });
    assert(sv.status === 200, "/profile/survey");
    const prof = await req("GET", "/profile", { token });
    assert(
      prof.status === 200 && (prof.json.memories || []).length >= 2,
      "memory seeding via survey"
    );

    // Clients / patients (professional mode)
    const cc = await req("POST", "/clients", {
      token, body: { name: "Ramesh Gowda", kind: "patient", summary: "42M" },
    });
    assert(cc.status === 200 && cc.json.client?.id, "/clients create");
    const cid = cc.json.client.id;
    const cn = await req("POST", `/clients/${cid}/notes`, {
      token, body: { text: "allergic to penicillin" },
    });
    assert(cn.status === 200 && cn.json.note?.id, "/clients add note");
    const cp = await req("GET", `/clients/${cid}`, { token });
    assert(
      cp.status === 200 &&
        cp.json.client?.name === "Ramesh Gowda" &&
        cp.json.notes?.length === 1 &&
        Array.isArray(cp.json.documents),
      "/clients case file"
    );
    const cl = await req("GET", "/clients", { token });
    assert(cl.status === 200 && cl.json.clients?.length === 1, "/clients list");
    const cd = await req("DELETE", `/clients/${cid}`, { token });
    assert(cd.status === 200, "/clients delete");

    // Documents: upload (no AI key — analysis is skipped gracefully) then
    // DELETE. Regression: delete used to crash the process with a
    // ReferenceError (`memory` was never imported in routes/docs.js).
    {
      const fd = new FormData();
      fd.append("note", "smoke receipt");
      fd.append(
        "file",
        new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3])],
          { type: "image/jpeg" }),
        "smoke.jpg"
      );
      const up = await fetch(BASE + "/docs", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: fd,
      });
      const upJson = await up.json();
      assert(up.status === 200 && upJson.document?.id, "/docs upload");
      const dd = await req("DELETE", `/docs/${upJson.document.id}`, { token });
      assert(dd.status === 200, "/docs delete (regression: must not crash)");
      const dl = await req("GET", "/docs", { token });
      assert(dl.status === 200 && dl.json.documents.length === 0, "/docs list empty");
    }

    // ID DOCUMENTS ("show my Aadhaar card"): saving with an ID note must
    // categorise as `id` from the words alone (no AI), and the doc must
    // come back tagged so the app can show + Send it.
    {
      const fd = new FormData();
      fd.append("note", "this is my aadhaar card");
      fd.append(
        "file",
        new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9, 9])],
          { type: "image/jpeg" }),
        "aadhaar.jpg"
      );
      const up = await fetch(BASE + "/docs", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: fd,
      });
      const upJson = await up.json();
      assert(
        up.status === 200 && upJson.document?.category === "id",
        "aadhaar note categorised as id"
      );
      const dl = await req("GET", "/docs", { token });
      assert(
        dl.status === 200 && dl.json.documents.some((d) => d.category === "id"),
        "id document listed"
      );
    }

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
    const noauth = await req("GET", "/clients");
    assert(noauth.status === 401, "unauthenticated /clients should 401");

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
