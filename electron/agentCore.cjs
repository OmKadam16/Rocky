"use strict";
/**
 * Booking Agent v2 core. The code lives in shared/agentCore.mjs so the
 * Android app runs exactly the same loop and gates; Electron's main process
 * loads it with require(esm) (Node 22+).
 */
module.exports = require("../shared/agentCore.mjs");
