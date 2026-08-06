/**
 * GET /actions — the user-visible audit trail (Phase 1, item 1.7).
 * Newest first, cursor-paged: ?limit=50&before=<last id from previous page>.
 * Mounted behind appAuth in server.js; users only ever see their own rows.
 */
const express = require("express");
const audit = require("../audit/log");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const rows = await audit.list(req.user.sub, {
      limit: req.query.limit,
      before: req.query.before,
    });
    res.json({
      actions: rows,
      next_before: rows.length ? rows[rows.length - 1].id : null,
    });
  } catch (e) {
    res.status(500).json({ error: "could not read action log" });
  }
});

module.exports = router;
