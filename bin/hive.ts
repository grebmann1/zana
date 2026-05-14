#!/usr/bin/env node
export {};

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const appRoot = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);

const hasFlag = (flag) => args.includes(flag);

// --- Subcommands ---

const subcommand = args[0];

if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  printHelp();
  process.exit(0);
}

if (subcommand === "init") {
  const { initHiveDir } = require(path.join(appRoot, "packages", "core", "dist", "src", "hive-init.js"));
  const initArgs = args.slice(1);
  const wizardMode = initArgs[0] === "wizard" || initArgs.includes("--wizard");
  if (wizardMode) {
    runInitWizard(initArgs.slice(initArgs[0] === "wizard" ? 1 : 0));
    process.exit(0);
  }

  const target = initArgs.find((arg) => !arg.startsWith("-")) || process.cwd();
  const workspace = path.resolve(target);
  initHiveDir(workspace, { force: initArgs.includes("--force") });
  process.exit(0);
}

if (subcommand === "migrate") {
  runMigrate(args.slice(1));
  process.exit(0);
}

if (subcommand === "status") {
  printStatus();
  process.exit(0);
}

if (subcommand === "stop") {
  stopHive(args[1]);
  process.exit(0);
}

if (subcommand === "config") {
  const { execFileSync } = require("child_process");
  const daemonBin = path.join(appRoot, "packages", "core", "dist", "bin", "hive-daemon.js");
  try {
    execFileSync(process.execPath, [daemonBin, "config", ...args.slice(1)], { stdio: "inherit" });
  } catch (err) {
    process.exit(err.status || 1);
  }
  process.exit(0);
}

if (subcommand === "headless" || subcommand === "start") {
  launchHeadless(args.slice(1));
} else {
  // Default: launch headless for the given workspace
  launchHeadless(args);
}

// --- Help ---

function printHelp() {
  console.log(`
Usage: zana [command] [options]

Commands:
  init [path]          Initialize .zana/ in a project directory
  init wizard [path]   Guided setup: initialize + register MCP server
  migrate [path]       Run pending migrations
  status               Show running hive instances
  stop <id|port>       Stop a running hive
  config [args...]     Print or modify module configuration
  headless [path]      Run hive-daemon in foreground (default)

Options:
  --repair-mcp        With init wizard, overwrite stale hive MCP config
  --help, -h           Show this help
`);
}

function runInitWizard(initArgs) {
  const { initHiveDir, isHiveInitialized } = require(path.join(appRoot, "packages", "core", "dist", "src", "hive-init.js"));
  const { ensureMcpServer } = require(path.join(appRoot, "packages", "mcp", "dist", "src", "claude-settings.js"));

  const target = initArgs.find((arg) => !arg.startsWith("-")) || process.cwd();
  const workspace = path.resolve(target);
  const force = initArgs.includes("--force");
  const repairMcp = initArgs.includes("--repair-mcp");

  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    console.error(`zana init wizard: not a valid directory: ${workspace}`);
    process.exit(1);
  }

  const wasInitialized = isHiveInitialized(workspace);
  if (!wasInitialized || force) {
    initHiveDir(workspace, { force });
  }

  const localMcpBin = path.join(appRoot, "packages", "mcp", "dist", "bin", "zana-mcp-server.js");
  const escapedLocalMcpBin = localMcpBin.replace(/"/g, '\\"');
  const mcpCommand = `node "${escapedLocalMcpBin}" || npx --yes zana-mcp-server`;
  const mcpResult = ensureMcpServer({
    serverName: "zana",
    repairIfDifferent: repairMcp,
    serverConfig: {
      command: "sh",
      args: ["-lc", mcpCommand],
    },
  });

  console.log("\x1b[36mzana init wizard\x1b[0m complete");
  console.log();
  console.log(`  Workspace:      ${workspace}`);
  console.log(`  .zana/:         ${wasInitialized && !force ? "already initialized" : "initialized"}`);
  console.log(`  MCP server:     ${mcpResult.status} (zana)`);
  console.log(`  Claude settings: ${mcpResult.settingsPath}`);
  if (mcpResult.status === "different" && !repairMcp) {
    console.log("  MCP note:       existing zana config differs; rerun with --repair-mcp to overwrite");
  }
  console.log();
  console.log("Next steps:");
  console.log("  1) Restart Claude Code if it was open");
  console.log("  2) Run /zana inside your project");
  console.log("  3) Verify with: zana status");
}

// --- Headless mode ---

function launchHeadless(restArgs) {
  let target = restArgs.find((a) => !a.startsWith("-")) || process.cwd();
  const workspace = path.resolve(target);

  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    console.error(`zana: not a valid directory: ${workspace}`);
    process.exit(1);
  }

  // Auto-init .zana/ on first launch
  const { isHiveInitialized, initHiveDir } = require(path.join(appRoot, "packages", "core", "dist", "src", "hive-init.js"));
  if (!isHiveInitialized(workspace)) {
    initHiveDir(workspace);
  }

  const daemonBin = path.join(appRoot, "packages", "core", "dist", "bin", "hive-daemon.js");
  const daemonArgs = [`--workspace=${workspace}`, ...restArgs.filter((a) => a.startsWith("-"))];

  const child = spawn(process.execPath, [daemonBin, ...daemonArgs], {
    stdio: "inherit",
    env: { ...process.env },
  });
  child.on("exit", (code) => process.exit(code || 0));
}

// --- Status command ---

function printStatus() {
  const hivesDir = path.join(os.homedir(), ".zana", "hives");
  if (!fs.existsSync(hivesDir)) {
    console.log("No running hives.");
    return;
  }

  const files = fs.readdirSync(hivesDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("No running hives.");
    return;
  }

  const alive = [];
  for (const f of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(hivesDir, f), "utf8"));
      if (isProcessAlive(entry.pid)) {
        alive.push(entry);
      } else {
        try { fs.unlinkSync(path.join(hivesDir, f)); } catch {}
      }
    } catch {}
  }

  if (alive.length === 0) {
    console.log("No running hives.");
    return;
  }

  console.log(`\x1b[36m${alive.length} hive(s) running:\x1b[0m\n`);
  for (const h of alive) {
    const uptime = formatUptime(h.startedAt);
    console.log(`  \x1b[32m●\x1b[0m \x1b[1m${h.id}\x1b[0m  port:${h.port}  pid:${h.pid}  ${uptime}`);
    console.log(`    ${h.workspace}`);
    console.log();
  }
}

// --- Stop command ---

function stopHive(idOrPort) {
  if (!idOrPort) {
    console.error("Usage: zana stop <id|port>");
    process.exit(1);
  }

  const hivesDir = path.join(os.homedir(), ".zana", "hives");
  if (!fs.existsSync(hivesDir)) {
    console.error("No running hives.");
    process.exit(1);
  }

  const files = fs.readdirSync(hivesDir).filter((f) => f.endsWith(".json"));
  let target = null;

  for (const f of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(hivesDir, f), "utf8"));
      if (entry.id === idOrPort || String(entry.port) === idOrPort) {
        target = entry;
        break;
      }
    } catch {}
  }

  if (!target) {
    console.error(`Hive not found: ${idOrPort}`);
    process.exit(1);
  }

  if (!isProcessAlive(target.pid)) {
    console.log(`Hive ${target.id} is already dead. Cleaning up.`);
    try { fs.unlinkSync(path.join(hivesDir, `${target.id}.json`)); } catch {}
    return;
  }

  try {
    process.kill(target.pid, "SIGTERM");
    console.log(`\x1b[33mStopped\x1b[0m hive ${target.id} (pid ${target.pid})`);
  } catch (err) {
    console.error(`Failed to stop hive ${target.id}: ${err.message}`);
    process.exit(1);
  }
}

// --- Migrate command ---

function runMigrate(restArgs) {
  const { migrate, dryRun } = require(path.join(appRoot, "packages", "core", "dist", "src", "hive-migrate.js"));

  const isDryRun = restArgs.includes("--dry-run");
  const force = restArgs.includes("--force");
  const verbose = restArgs.includes("--verbose");

  const target = restArgs.find((a) => !a.startsWith("-")) || process.cwd();
  const workspace = path.resolve(target);

  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    console.error(`zana migrate: not a valid directory: ${workspace}`);
    process.exit(1);
  }

  console.log(`\x1b[36mzana migrate\x1b[0m ${isDryRun ? "(dry run) " : ""}${workspace}`);
  console.log();

  if (isDryRun && verbose) {
    const plan = dryRun(workspace);
    if (plan.files.length === 0) {
      console.log("  Nothing to migrate.");
      return;
    }
    console.log(`  Found ${plan.files.length} file(s) to migrate from ${plan.globalDir}`);
    console.log();
  }

  const result = migrate(workspace, { dryRun: isDryRun, force, verbose });

  console.log();
  console.log(`\x1b[36m--- Summary ---\x1b[0m`);
  console.log(`  Copied:  ${result.copied}`);
  console.log(`  Skipped: ${result.skipped}`);

  if (result.errors.length > 0) {
    console.log(`  Errors:  ${result.errors.length}`);
    for (const err of result.errors) {
      console.log(`    \x1b[31m!\x1b[0m ${err}`);
    }
  }

  if (!isDryRun && result.copied > 0) {
    console.log();
    console.log("  Source files in ~/.zana/ were NOT deleted.");
    console.log("  You can remove them manually once you verify the migration.");
  }
}

// --- Helpers ---

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatUptime(startedAt) {
  const ms = Date.now() - new Date(startedAt).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}
