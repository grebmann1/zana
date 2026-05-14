const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function getClaudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function readClaudeSettings(settingsPath = getClaudeSettingsPath()) {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function writeClaudeSettings(settings, settingsPath = getClaudeSettingsPath()) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function ensureMcpServer({
  serverName = "zana",
  serverConfig,
  settingsPath = getClaudeSettingsPath(),
  overwrite = false,
  repairIfDifferent = false,
  migrateFrom = ["hive"],
}) {
  if (!serverConfig || typeof serverConfig !== "object") {
    throw new Error("ensureMcpServer requires a valid serverConfig object");
  }

  const settings = readClaudeSettings(settingsPath);
  if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
    settings.mcpServers = {};
  }

  // Hard cutover support: remove legacy server keys when migrating to new key.
  if (Array.isArray(migrateFrom)) {
    for (const legacyName of migrateFrom) {
      if (legacyName && legacyName !== serverName && settings.mcpServers[legacyName]) {
        delete settings.mcpServers[legacyName];
      }
    }
  }

  const current = settings.mcpServers[serverName];
  if (!overwrite && current) {
    const currentJson = JSON.stringify(current);
    const nextJson = JSON.stringify(serverConfig);
    if (currentJson === nextJson) {
      return { status: "unchanged", settingsPath, serverName, serverConfig: current };
    }
    if (!repairIfDifferent) {
      return { status: "different", settingsPath, serverName, serverConfig: current };
    }
  }

  const nextStatus = current ? "updated" : "added";
  settings.mcpServers[serverName] = serverConfig;
  writeClaudeSettings(settings, settingsPath);

  return { status: nextStatus, settingsPath, serverName, serverConfig };
}

module.exports = {
  getClaudeSettingsPath,
  readClaudeSettings,
  writeClaudeSettings,
  ensureMcpServer,
};
