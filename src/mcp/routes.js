/**
 * MCP MANAGEMENT API (§12).
 *
 * Every handler resolves the row by (id AND user_id), so an id belonging to
 * another user is indistinguishable from one that does not exist — no
 * endpoint can leak the existence of another tenant's server (§6).
 *
 * No response is ever built by hand: everything goes through
 * schema.toClient(), which structurally cannot emit secrets (§13).
 */
const router = require("express").Router();
const { query, one, run } = require("../db");
const schema = require("./schema");
const manager = require("./manager");

const now = () => Date.now();

function uid(req) {
  const id = Number(req.user?.sub);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function requireUser(req, res) {
  const id = uid(req);
  if (!id) {
    res.status(401).json({ error: "sign in to manage MCP servers" });
    return null;
  }
  return id;
}

/** Loads a server owned by this user, or null. */
async function owned(userId, id) {
  return one(`SELECT * FROM mcp_servers WHERE user_id=$1 AND id=$2`, [
    userId,
    Number(id),
  ]);
}

// GET /mcp/servers
router.get("/servers", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const rows = await query(
    `SELECT * FROM mcp_servers WHERE user_id=$1 ORDER BY id DESC`,
    [user]
  );
  res.json({
    servers: rows.map((r) => schema.toClient(r, manager.statusOf(user, r.id))),
  });
});

// POST /mcp/servers
router.post("/servers", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const name = String(req.body?.name || "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "name required" });

  const transport = String(req.body?.transport || "http").toLowerCase();
  if (!["http", "sse", "stdio"].includes(transport)) {
    return res.status(400).json({ error: "transport must be http, sse or stdio" });
  }
  const { config, secrets } = schema.splitSecrets(req.body);
  if (transport === "stdio" && !config.command) {
    return res.status(400).json({ error: "stdio needs config.command" });
  }
  if (transport !== "stdio" && !config.url) {
    return res.status(400).json({ error: `${transport} needs config.url` });
  }

  try {
    const row = await one(
      `INSERT INTO mcp_servers
         (user_id,name,description,transport,config,secrets_enc,enabled,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,'disconnected',$7,$7) RETURNING *`,
      [
        user,
        name,
        String(req.body?.description || "").slice(0, 300),
        transport,
        JSON.stringify(config),
        schema.encryptSecrets(secrets),
        now(),
      ]
    );
    res.status(201).json({ server: schema.toClient(row) });
  } catch (e) {
    if (/idx_mcp_user_name|unique/i.test(e.message)) {
      return res.status(409).json({ error: "a server with that name already exists" });
    }
    res.status(500).json({ error: "could not save the server" });
  }
});

// GET /mcp/servers/:id
router.get("/servers/:id", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = await owned(user, req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json({ server: schema.toClient(row, manager.statusOf(user, row.id)) });
});

// PUT /mcp/servers/:id
router.put("/servers/:id", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = await owned(user, req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });

  const { config, secrets } = schema.splitSecrets(req.body);
  const merged = { ...(row.config || {}), ...config };
  // Only replace stored secrets when new ones were supplied — a plain
  // rename must not wipe the credentials.
  const secretsEnc = Object.keys(secrets).length
    ? schema.encryptSecrets(secrets)
    : row.secrets_enc;

  const updated = await one(
    `UPDATE mcp_servers SET
       name=COALESCE(NULLIF($3,''),name),
       description=COALESCE(NULLIF($4,''),description),
       transport=COALESCE(NULLIF($5,''),transport),
       config=$6, secrets_enc=$7, updated_at=$8
     WHERE user_id=$1 AND id=$2 RETURNING *`,
    [
      user,
      row.id,
      String(req.body?.name || "").trim(),
      String(req.body?.description || ""),
      String(req.body?.transport || ""),
      JSON.stringify(merged),
      secretsEnc,
      now(),
    ]
  );
  await manager.disconnect(user, row.id); // config changed → stale session
  res.json({ server: schema.toClient(updated) });
});

// DELETE /mcp/servers/:id
router.delete("/servers/:id", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = await owned(user, req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  await manager.disconnect(user, row.id);
  await run(`DELETE FROM mcp_servers WHERE user_id=$1 AND id=$2`, [user, row.id]);
  res.json({ ok: true });
});

// POST /mcp/servers/:id/connect   (and /reconnect — same operation)
for (const path of ["/servers/:id/connect", "/servers/:id/reconnect"]) {
  router.post(path, async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const row = await owned(user, req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });
    if (row.enabled !== 1) {
      return res.status(400).json({ error: "server is disabled" });
    }

    const secrets = schema.decryptSecrets(row.secrets_enc);
    if (row.secrets_enc && secrets === null) {
      await markStatus(user, row.id, "error", "stored credentials could not be read — re-enter them");
      return res.status(400).json({ error: "stored credentials could not be read — re-enter them" });
    }

    await markStatus(user, row.id, "connecting", "");
    const out = await manager.connect(user, row, secrets || {});
    const saved = await one(
      `UPDATE mcp_servers SET status=$3, last_error=$4, tools_cache=$5,
         last_connected_at=CASE WHEN $3='connected' THEN $6 ELSE last_connected_at END,
         updated_at=$6
       WHERE user_id=$1 AND id=$2 RETURNING *`,
      [user, row.id, out.status, out.error || "", JSON.stringify(out.tools || []), now()]
    );
    // A failed connection is a 200 with an error status, not a 500: the
    // settings screen needs to render the badge, not a crash.
    res.json({ server: schema.toClient(saved, manager.statusOf(user, row.id)) });
  });
}

// POST /mcp/servers/:id/disconnect
router.post("/servers/:id/disconnect", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = await owned(user, req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  await manager.disconnect(user, row.id);
  const saved = await one(
    `UPDATE mcp_servers SET status='disconnected', tools_cache='[]', updated_at=$3
      WHERE user_id=$1 AND id=$2 RETURNING *`,
    [user, row.id, now()]
  );
  res.json({ server: schema.toClient(saved) });
});

// PUT /mcp/servers/:id/enabled
router.put("/servers/:id/enabled", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = await owned(user, req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const enabled = req.body?.enabled === true || req.body?.enabled === "true";
  if (!enabled) await manager.disconnect(user, row.id);
  const saved = await one(
    `UPDATE mcp_servers SET enabled=$3, status=$4, updated_at=$5
      WHERE user_id=$1 AND id=$2 RETURNING *`,
    [user, row.id, enabled ? 1 : 0, enabled ? "disconnected" : "disabled", now()]
  );
  res.json({ server: schema.toClient(saved) });
});

// GET /mcp/servers/:id/tools
router.get("/servers/:id/tools", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = await owned(user, req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const live = manager.statusOf(user, row.id);
  res.json({
    status: live?.status || row.status,
    tools: schema.toClient(row, live).tools,
  });
});

async function markStatus(user, id, status, error) {
  await run(
    `UPDATE mcp_servers SET status=$3, last_error=$4, updated_at=$5
      WHERE user_id=$1 AND id=$2`,
    [user, id, status, error, now()]
  );
}

/**
 * Reconnects every enabled server for a user (called when a live agent
 * session starts, so tools are ready before the first request).
 */
async function connectAllForUser(userId) {
  const rows = await query(
    `SELECT * FROM mcp_servers WHERE user_id=$1 AND enabled=1`,
    [userId]
  );
  const out = [];
  for (const row of rows) {
    const secrets = schema.decryptSecrets(row.secrets_enc) || {};
    const r = await manager.connect(userId, row, secrets);
    await run(
      `UPDATE mcp_servers SET status=$3, last_error=$4, tools_cache=$5, updated_at=$6
        WHERE user_id=$1 AND id=$2`,
      [userId, row.id, r.status, r.error || "", JSON.stringify(r.tools || []), now()]
    );
    out.push({ id: row.id, name: row.name, ...r });
  }
  return out;
}

module.exports = router;
module.exports.connectAllForUser = connectAllForUser;
