/**
 * PROFILE — the onboarding survey's landing point.
 *
 * POST /profile/survey  { name, location, gender, preferences: [..] }
 *
 * Two destinations, one call:
 *  1. users table — name + gender (gender drives the opposite-gender
 *     avatar; name personalizes every reply).
 *  2. agent_memories — location and preferences become importance-3
 *     memories, so EVERY agent (voice loop, chat, the D-ID face) knows
 *     the user from minute one, exactly like facts learned in
 *     conversation. No separate "profile lookup" code path to maintain.
 *
 * GET /profile — the profile as the app sees it (user + memories).
 */
const router = require("express").Router();
const db = require("../db");
const memory = require("../agents/memory");

function uidOf(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.post("/survey", async (req, res) => {
  const uid = uidOf(req);
  if (!uid) return res.status(401).json({ error: "sign in required" });

  const { name, location, gender, preferences } = req.body || {};
  const cleanName = typeof name === "string" ? name.trim().slice(0, 80) : "";
  const cleanLoc =
    typeof location === "string" ? location.trim().slice(0, 120) : "";
  const prefs = Array.isArray(preferences)
    ? preferences
        .filter((p) => typeof p === "string" && p.trim())
        .map((p) => p.trim().slice(0, 60))
        .slice(0, 12)
    : [];

  try {
    if (cleanName) {
      await db.run("UPDATE users SET name = $1 WHERE id = $2", [cleanName, uid]);
    }
    if (gender !== undefined) {
      await db.setGender(uid, gender);
    }
    if (cleanName) {
      await memory.saveMemory(uid, `User's name is ${cleanName}`, 3);
    }
    if (cleanLoc) {
      await memory.saveMemory(uid, `User lives in ${cleanLoc}`, 3);
    }
    if (prefs.length) {
      await memory.saveMemory(
        uid,
        `User's interests: ${prefs.join(", ")}`,
        2
      );
    }
    const user = await db.findById(uid);
    res.json({ ok: true, user: db.publicUser(user) });
  } catch (e) {
    console.error("survey save failed:", e.message);
    res.status(500).json({ error: "could not save profile" });
  }
});

router.get("/", async (req, res) => {
  const uid = uidOf(req);
  if (!uid) return res.status(401).json({ error: "sign in required" });
  try {
    const user = await db.findById(uid);
    const memories = await memory.listMemories(uid);
    res.json({
      user: user ? db.publicUser(user) : null,
      memories: memories.map((m) => m.fact),
    });
  } catch (e) {
    res.status(500).json({ error: "could not load profile" });
  }
});

module.exports = router;
