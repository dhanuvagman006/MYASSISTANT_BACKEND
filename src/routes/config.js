const router = require("express").Router();
const remoteConfig = require("../config/remoteConfig");

router.get("/", (_req, res) => res.json(remoteConfig));

module.exports = router;
