import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BIN_DIR, CLAUDE_SETTINGS_BACKUP } from "./config";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SessionEnd",
];

function homeDir() {
  return process.env.HOME || os.homedir();
}

export function wrapperPath() {
  return path.join(BIN_DIR, "post-hook.sh");
}

export function settingsPath() {
  return path.join(homeDir(), ".claude", "settings.json");
}

function backupPath() {
  return CLAUDE_SETTINGS_BACKUP;
}

function readSettings() {
  const p = settingsPath();
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `~/.claude/settings.json isn't valid JSON (${err.message}). ` +
        `Fix it manually, then try installing hooks again.`,
    );
  }
}

function writeSettings(obj) {
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const serialized = JSON.stringify(obj, null, 2) + "\n";
  fs.writeFileSync(p, serialized, "utf8");
}

function backupIfNeeded() {
  const src = settingsPath();
  const dst = backupPath();
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dst)) return;
  fs.copyFileSync(src, dst);
}

export function installHooks(port) {
  if (!Number.isFinite(port)) {
    throw new Error("installHooks: invalid port");
  }
  const scriptContents = fs.readFileSync(
    path.join(__dirname, "hook-wrapper.sh"),
    "utf8",
  );
  const scriptPath = wrapperPath();
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, scriptContents, { mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);

  backupIfNeeded();
  const settings = readSettings();
  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }

  for (const event of HOOK_EVENTS) {
    const arr = Array.isArray(settings.hooks[event])
      ? settings.hooks[event]
      : [];
    const filtered = arr.filter((entry) => !isOurEntry(entry));
    filtered.push(ourEntry());
    settings.hooks[event] = filtered;
  }

  writeSettings(settings);
  return { ok: true, scriptPath, settingsPath: settingsPath() };
}

export function uninstallHooks() {
  const p = settingsPath();
  if (fs.existsSync(p)) {
    const settings = readSettings();
    if (settings.hooks && typeof settings.hooks === "object") {
      for (const event of Object.keys(settings.hooks)) {
        const arr = settings.hooks[event];
        if (!Array.isArray(arr)) continue;
        const filtered = arr.filter((entry) => !isOurEntry(entry));
        if (filtered.length === 0) {
          delete settings.hooks[event];
        } else {
          settings.hooks[event] = filtered;
        }
      }
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
      writeSettings(settings);
    }
  }
  return { ok: true };
}

export function isHooksInstalled() {
  const p = settingsPath();
  if (!fs.existsSync(p)) return false;
  let settings;
  try {
    settings = readSettings();
  } catch {
    return false;
  }
  if (!settings.hooks || typeof settings.hooks !== "object") return false;
  for (const arr of Object.values(settings.hooks)) {
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (isOurEntry(entry)) return true;
    }
  }
  return false;
}

function isOurEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (!Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) =>
      h &&
      typeof h === "object" &&
      typeof h.command === "string" &&
      h.command.includes("zana") &&
      h.command.includes("post-hook.sh"),
  );
}

function ourEntry() {
  return {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: `bash ${wrapperPath()}`,
        timeout: 2,
      },
    ],
  };
}

export function installMcpServer(port) {
  if (process.env.HIVE_SKIP_MCP_INSTALL === "1") return { ok: true, skipped: true };
  if (!Number.isFinite(port)) return { ok: false, error: "invalid port" };

  const mcpServerPath = path.join(__dirname, "orchestrator-mcp.js");
  backupIfNeeded();
  const settings = readSettings();

  if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
    settings.mcpServers = {};
  }

  settings.mcpServers["hive"] = {
    command: "node",
    args: [mcpServerPath],
    env: {
      HIVE_PORT: String(port),
      HIVE_ID: process.env.HIVE_ID || "default",
    },
  };

  writeSettings(settings);
  return { ok: true };
}

export function uninstallMcpServer() {
  const p = settingsPath();
  if (!fs.existsSync(p)) return { ok: true };
  const settings = readSettings();
  if (settings.mcpServers && (settings.mcpServers.zana || settings.mcpServers.hive)) {
    delete settings.mcpServers.zana;
    // Also clean up legacy key if present.
    delete settings.mcpServers.hive;
    if (Object.keys(settings.mcpServers).length === 0) {
      delete settings.mcpServers;
    }
    writeSettings(settings);
  }
  return { ok: true };
}

export function isMcpInstalled() {
  const p = settingsPath();
  if (!fs.existsSync(p)) return false;
  try {
    const settings = readSettings();
    return !!(settings.mcpServers && settings.mcpServers.zana);
  } catch {
    return false;
  }
}

