#!/usr/bin/env node

// Postinstall: register zana MCP server in ~/.claude/settings.json
// Safe to re-run — only adds if not already present.

const path = require("node:path");
const { ensureMcpServer, getClaudeSettingsPath } = require("../src/claude-settings.js");

const SETTINGS_PATH = getClaudeSettingsPath();
const MCP_SERVER_PATH = path.resolve(__dirname, "..", "src", "mcp-server.js");

function main() {
  // Don't run in CI
  if (process.env.CI || process.env.GITHUB_ACTIONS) return;

  const result = ensureMcpServer({
    serverName: "zana",
    settingsPath: SETTINGS_PATH,
    repairIfDifferent: true,
    serverConfig: {
      command: "node",
      args: [MCP_SERVER_PATH],
    },
  });

  if (result.status === "unchanged") {
    console.log("[zana] MCP server already configured in ~/.claude/settings.json");
    return;
  }

  if (result.status === "updated") {
    console.log("[zana] MCP server config repaired in ~/.claude/settings.json");
    return;
  }

  console.log("[zana] MCP server registered in ~/.claude/settings.json");
  console.log("[zana] Use /zana in Claude Code to start orchestrating agents.");
}

try {
  main();
} catch (err) {
  // Never fail install on postinstall errors
  console.warn("[zana] setup warning:", err.message);
}
