#!/usr/bin/env node
export {};

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const args = process.argv.slice(2);

const HELP = `Usage: hive-daemon [options] [command]

Options:
  --workspace <path>   Working directory (default: cwd)
  --port <number>      API server port (default: 47402)
  --background         Fork to background (daemonize)
  --pid-file <path>    PID file location
  --token <string>     Static auth token (bypasses auto-generated)
  --help, -h           Show this help

Commands:
  service install      Install as login service (launchd/systemd)
  service uninstall    Remove login service
  service status       Show service status
  service logs [n]     Show last n log lines (default: 50)
  plugin init <name>   Create a new plugin scaffold
  plugin list          List installed plugins
  plugin enable <id>   Enable a plugin
  plugin disable <id>  Disable a plugin
  plugin link <path>   Symlink local plugin for development
  plugin unlink <id>   Remove plugin symlink
`;

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}

const serviceIdx = args.indexOf("service");
if (serviceIdx !== -1) {
  const sub = args[serviceIdx + 1];
  if (!sub || !["install", "uninstall", "status", "logs"].includes(sub)) {
    console.error("hive-daemon: unknown service command — expected install|uninstall|status|logs");
    process.exit(1);
  }
  let svc;
  try {
    svc = require("../src/service-manager.js");
  } catch (e) {
    console.error("hive-daemon: service-manager not available — ensure packages/core/src/service-manager.js is built");
    process.exit(1);
  }
  try {
    if (sub === "install") {
      svc.install();
      console.log("Service installed.");
    } else if (sub === "uninstall") {
      svc.uninstall();
      console.log("Service uninstalled.");
    } else if (sub === "status") {
      const result = svc.status();
      const state = result.running ? `running (pid ${result.pid})` : "stopped";
      console.log(`installed: ${result.installed}\nstatus: ${state}`);
    } else if (sub === "logs") {
      const n = parseInt(args[serviceIdx + 2] || "50", 10);
      const output = svc.logs(n);
      if (output) process.stdout.write(output);
    }
  } catch (err) {
    console.error(`hive-daemon: service ${sub} failed —`, err.message || err);
    process.exit(1);
  }
  process.exit(0);
}

const pluginIdx = args.indexOf("plugin");
if (pluginIdx !== -1) {
  const sub = args[pluginIdx + 1];
  if (!sub || !["init", "list", "enable", "disable", "link", "unlink"].includes(sub)) {
    console.error("hive-daemon: unknown plugin command — expected init|list|enable|disable|link|unlink");
    process.exit(1);
  }

  const { PLUGINS_DIR, SETTINGS_PATH } = require("../src/config.js");
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });

  if (sub === "init") {
    const name = args[pluginIdx + 2];
    if (!name) {
      console.error("hive-daemon: plugin init requires <name>");
      process.exit(1);
    }
    const targetDir = path.join(PLUGINS_DIR, name);
    if (fs.existsSync(targetDir)) {
      console.error(`hive-daemon: plugin directory already exists: ${targetDir}`);
      process.exit(1);
    }
    const { scaffold } = require("../src/plugin-scaffold.js");
    scaffold(name, targetDir);
    console.log(`Plugin scaffolded at ${targetDir}`);
  } else if (sub === "list") {
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    let settings: any = {};
    try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")); } catch {}
    const rows: Array<{ id: string; name: string; version: string; status: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const manifestPath = path.join(PLUGINS_DIR, entry.name, "plugin.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const enabled = settings.plugins?.[manifest.id]?.enabled !== false;
        rows.push({ id: manifest.id, name: manifest.name, version: manifest.version, status: enabled ? "enabled" : "disabled" });
      } catch {}
    }
    if (rows.length === 0) {
      console.log("No plugins installed.");
    } else {
      const idW = Math.max(2, ...rows.map((r) => r.id.length));
      const nameW = Math.max(4, ...rows.map((r) => r.name.length));
      const verW = Math.max(7, ...rows.map((r) => r.version.length));
      const header = `${"ID".padEnd(idW)}  ${"Name".padEnd(nameW)}  ${"Version".padEnd(verW)}  Status`;
      console.log(header);
      console.log("-".repeat(header.length));
      for (const r of rows) {
        console.log(`${r.id.padEnd(idW)}  ${r.name.padEnd(nameW)}  ${r.version.padEnd(verW)}  ${r.status}`);
      }
    }
  } else if (sub === "enable" || sub === "disable") {
    const id = args[pluginIdx + 2];
    if (!id) {
      console.error(`hive-daemon: plugin ${sub} requires <id>`);
      process.exit(1);
    }
    let settings: any = {};
    try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")); } catch {}
    if (!settings.plugins) settings.plugins = {};
    if (!settings.plugins[id]) settings.plugins[id] = {};
    settings.plugins[id].enabled = sub === "enable";
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
    console.log(`Plugin "${id}" ${sub}d.`);
  } else if (sub === "link") {
    const linkPath = args[pluginIdx + 2];
    if (!linkPath) {
      console.error("hive-daemon: plugin link requires <path>");
      process.exit(1);
    }
    const absPath = path.resolve(linkPath);
    const manifestPath = path.join(absPath, "plugin.json");
    if (!fs.existsSync(manifestPath)) {
      console.error(`hive-daemon: no plugin.json found at ${absPath}`);
      process.exit(1);
    }
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch (err) {
      console.error(`hive-daemon: invalid plugin.json: ${err.message}`);
      process.exit(1);
    }
    const symlinkTarget = path.join(PLUGINS_DIR, manifest.id);
    if (fs.existsSync(symlinkTarget)) {
      fs.rmSync(symlinkTarget, { recursive: true });
    }
    fs.symlinkSync(absPath, symlinkTarget, "dir");
    console.log(`Linked "${manifest.id}" -> ${absPath}`);
  } else if (sub === "unlink") {
    const id = args[pluginIdx + 2];
    if (!id) {
      console.error("hive-daemon: plugin unlink requires <id>");
      process.exit(1);
    }
    const symlinkTarget = path.join(PLUGINS_DIR, id);
    if (!fs.existsSync(symlinkTarget)) {
      console.error(`hive-daemon: plugin not found: ${id}`);
      process.exit(1);
    }
    const stat = fs.lstatSync(symlinkTarget);
    if (!stat.isSymbolicLink()) {
      console.error(`hive-daemon: "${id}" is not a symlink — use rm manually`);
      process.exit(1);
    }
    fs.unlinkSync(symlinkTarget);
    console.log(`Unlinked "${id}".`);
  }

  process.exit(0);
}

// ─── config subcommand ─────────────────────────────────────────────────────
const configIdx = args.indexOf("config");
if (configIdx !== -1) {
  const action = args[configIdx + 1];
  if (!action || !["list", "get", "set", "reset"].includes(action)) {
    console.error("Usage: hive-daemon config list|get|set|reset [module] [key] [value]");
    process.exit(1);
  }

  const workspaceContext = require("../src/workspace-context.js");
  workspaceContext.init(process.env.HIVE_WORKSPACE || process.cwd());
  const moduleConfig = require("../src/module-config.js");
  const MODULES_DIR = path.resolve(__dirname, "..", "modules");

  const SYSTEM_SCHEMA = {
    maxConcurrentAgents: { type: "integer", default: 10 },
    initTimeout: { type: "integer", default: 10000 },
    suspendTimeout: { type: "integer", default: 5000 },
    hotReload: { type: "boolean", default: false },
  };

  function discoverSchemas() {
    const schemas = { system: SYSTEM_SCHEMA };
    if (!fs.existsSync(MODULES_DIR)) return schemas;
    for (const entry of fs.readdirSync(MODULES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mp = path.join(MODULES_DIR, entry.name, "module.json");
      try {
        const m = JSON.parse(fs.readFileSync(mp, "utf8"));
        if (m.id && m.configSchema) schemas[m.id] = m.configSchema;
      } catch {}
    }
    return schemas;
  }

  function coerce(value, schema) {
    if (!schema) return value;
    if (schema.type === "boolean") return value === "true";
    if (schema.type === "integer") return parseInt(value, 10);
    if (schema.type === "number") return parseFloat(value);
    return value;
  }

  moduleConfig.load();

  function getConfigForId(moduleId) {
    if (moduleId === "system") {
      const cfg = moduleConfig.get();
      return cfg?.system || {};
    }
    const mc = moduleConfig.getModuleConfig(moduleId);
    return mc.config || {};
  }

  function setConfigForId(moduleId, newConfig) {
    if (moduleId === "system") {
      const cfg = moduleConfig.get();
      cfg.system = { ...(cfg.system || {}), ...newConfig };
      moduleConfig.save(cfg);
    } else {
      moduleConfig.setModuleConfig(moduleId, { config: newConfig });
    }
  }

  if (action === "list") {
    const schemas = discoverSchemas();
    for (const [moduleId, schema] of Object.entries(schemas)) {
      const cfg = getConfigForId(moduleId);
      const pairs = Object.keys(schema).map(k => `${k}=${cfg[k] !== undefined ? cfg[k] : schema[k]?.default ?? ""}`);
      if (moduleId === "system") {
        console.log(`system: ${pairs.join(" ")}`);
      } else {
        const mc = moduleConfig.getModuleConfig(moduleId);
        const enabled = mc.enabled !== false ? "enabled" : "disabled";
        console.log(`${moduleId} (${enabled}): ${pairs.join(" ")}`);
      }
    }
  } else if (action === "get") {
    const moduleId = args[configIdx + 2];
    if (!moduleId) { console.error("Usage: hive-daemon config get <module>"); process.exit(1); }
    const schemas = discoverSchemas();
    const schema = schemas[moduleId];
    if (!schema) { console.error(`Module "${moduleId}" not found. Available: ${Object.keys(schemas).join(", ")}`); process.exit(1); }
    const cfg = getConfigForId(moduleId);
    for (const [key, def] of Object.entries<any>(schema)) {
      const val = cfg[key] !== undefined ? cfg[key] : def?.default;
      console.log(`  ${key}: ${val}`);
    }
  } else if (action === "set") {
    const moduleId = args[configIdx + 2];
    const key = args[configIdx + 3];
    const value = args[configIdx + 4];
    if (!moduleId || !key || value === undefined) {
      console.error("Usage: hive-daemon config set <module> <key> <value>");
      process.exit(1);
    }
    const schemas = discoverSchemas();
    const schema = schemas[moduleId];
    if (!schema) { console.error(`Module "${moduleId}" not found.`); process.exit(1); }
    if (!schema[key]) { console.error(`Unknown key "${key}". Available: ${Object.keys(schema).join(", ")}`); process.exit(1); }
    const coerced = coerce(value, schema[key]);
    const existing = getConfigForId(moduleId);
    const newConfig = { ...existing, [key]: coerced };
    setConfigForId(moduleId, newConfig);
    console.log(`✓ ${moduleId}.${key} = ${coerced}`);
  } else if (action === "reset") {
    const moduleId = args[configIdx + 2];
    if (!moduleId) { console.error("Usage: hive-daemon config reset <module>"); process.exit(1); }
    const schemas = discoverSchemas();
    const schema = schemas[moduleId];
    if (!schema) { console.error(`Module "${moduleId}" not found.`); process.exit(1); }
    const defaults = {};
    for (const [key, def] of Object.entries<any>(schema)) {
      if (def?.default !== undefined) defaults[key] = def.default;
    }
    setConfigForId(moduleId, defaults);
    console.log(`✓ ${moduleId} config reset to defaults`);
  }

  process.exit(0);
}

let workspace = process.env.HIVE_WORKSPACE || process.cwd();
let teamId: string | null = null;
let apiPort = parseInt(process.env.HIVE_PORT || "47402", 10);
let background = false;
let pidFile = path.join(os.homedir(), ".zana", "daemon.pid");
let token: string | null = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--workspace") {
    workspace = path.resolve(args[++i]);
  } else if (arg.startsWith("--workspace=")) {
    workspace = path.resolve(arg.slice("--workspace=".length));
  } else if (arg === "--team") {
    teamId = args[++i];
  } else if (arg.startsWith("--team=")) {
    teamId = arg.slice("--team=".length);
  } else if (arg === "--port") {
    apiPort = parseInt(args[++i], 10);
  } else if (arg.startsWith("--port=")) {
    apiPort = parseInt(arg.slice("--port=".length), 10);
  } else if (arg === "--background") {
    background = true;
  } else if (arg === "--pid-file") {
    pidFile = path.resolve(args[++i]);
  } else if (arg.startsWith("--pid-file=")) {
    pidFile = path.resolve(arg.slice("--pid-file=".length));
  } else if (arg === "--token") {
    token = args[++i];
  } else if (arg.startsWith("--token=")) {
    token = arg.slice("--token=".length);
  } else if (!arg.startsWith("-")) {
    workspace = path.resolve(arg);
  }
}

if (!fs.existsSync(workspace)) {
  console.error(`hive-daemon: directory does not exist: ${workspace}`);
  process.exit(1);
}

if (background) {
  const { spawn } = require("node:child_process");
  const fwdArgs = [`--workspace=${workspace}`, `--port=${apiPort}`, `--pid-file=${pidFile}`];
  if (teamId) fwdArgs.push(`--team=${teamId}`);
  if (token) fwdArgs.push(`--token=${token}`);
  const child = spawn(process.execPath, [__filename, ...fwdArgs], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HIVE_DAEMON_FORKED: "1" },
  });
  child.unref();
  console.log(`hive-daemon: forked to background (pid ${child.pid})`);
  console.log(`  API: http://127.0.0.1:${apiPort}`);
  console.log(`  PID: ${pidFile}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(pidFile), { recursive: true });
fs.writeFileSync(pidFile, String(process.pid), "utf8");

const core = require("../src/core.js");

async function main() {
  console.log(`\x1b[36m[hive-daemon]\x1b[0m workspace: ${workspace}`);
  console.log(`\x1b[36m[hive-daemon]\x1b[0m pid: ${process.pid}`);

  const hive = await core.init({
    workspace,
    headless: true,
    preferredPort: apiPort,
    token,
    onHook: (payload) => {
      if (payload.event === "Stop") {
        const termId = payload.hive_terminal_id;
        const agent = hive.agentManager.listAgents().find((a) => a.terminalId === termId);
        if (agent) {
          console.log(`\x1b[33m[agent:done]\x1b[0m ${agent.profileName} (${agent.id.slice(0, 8)})`);
        }
      }
    },
  });

  const port = hive.hookServerHandle?.port || apiPort;
  console.log(`\x1b[32m[hive-daemon]\x1b[0m ready — id: ${hive.hiveId}  api: http://127.0.0.1:${port}`);

  if (teamId) {
    console.log(`\x1b[36m[hive-daemon]\x1b[0m starting team: ${teamId}`);
    const teamPrompt = process.env.HIVE_TEAM_PROMPT || undefined;
    const result = await hive.teamManager.startTeam(teamId, { cwd: workspace, prompt: teamPrompt });
    if (result.ok) {
      console.log(`\x1b[32m[hive-daemon]\x1b[0m team started: ${result.orchestratorAgentId}`);
    } else {
      console.error(`\x1b[31m[hive-daemon]\x1b[0m team start failed: ${result.error}`);
    }
  }

  function shutdown() {
    console.log(`\n\x1b[33m[hive-daemon]\x1b[0m shutting down...`);
    const agents = hive.agentManager.listAgents();
    for (const agent of agents) {
      if (agent.state !== "terminated") {
        hive.agentManager.killAgent(agent.id);
      }
    }
    hive.shutdown();
    try { fs.unlinkSync(pidFile); } catch {}
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[hive-daemon] fatal:", err);
  try { fs.unlinkSync(pidFile); } catch {}
  process.exit(1);
});
