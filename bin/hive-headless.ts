#!/usr/bin/env node
export {};
// Deprecated: use hive-daemon instead
console.warn("[deprecated] bin/hive-headless.js → use packages/core/dist/bin/hive-daemon.js");
require("../packages/core/dist/bin/hive-daemon.js");
