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
  const { initProjectDir } = require(path.join(appRoot, "packages", "core", "dist", "src", "project", "init.js"));
  const initArgs = args.slice(1);
  const wizardMode = initArgs[0] === "wizard" || initArgs.includes("--wizard");
  if (wizardMode) {
    runInitWizard(initArgs.slice(initArgs[0] === "wizard" ? 1 : 0));
    process.exit(0);
  }

  const target = initArgs.find((arg) => !arg.startsWith("-")) || process.cwd();
  const workspace = path.resolve(target);
  initProjectDir(workspace, { force: initArgs.includes("--force") });
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
  if (args.includes("--all")) {
    stopAllDaemons().then(
      (n) => {
        console.log(`stopped ${n} daemon(s)`);
        process.exit(0);
      },
      (err) => {
        console.error(`zana stop --all: ${err.message || err}`);
        process.exit(1);
      }
    );
  } else {
    stopDaemon(args[1]);
    process.exit(0);
  }
}

if (subcommand === "ticket") {
  const sub = args[1];
  if (sub === "list") {
    listTickets(args.slice(2)).then(
      () => process.exit(0),
      (err) => {
        console.error(`zana ticket list: ${err.message || err}`);
        process.exit(1);
      }
    );
  } else if (sub === "rules" && args[2] === "list") {
    listTicketRules(args.slice(3)).then(
      () => process.exit(0),
      (err) => {
        console.error(`zana ticket rules list: ${err.message || err}`);
        process.exit(1);
      }
    );
  } else {
    console.error(`Usage:`);
    console.error(`  zana ticket list [--status <s>] [--workspace <path>]`);
    console.error(`  zana ticket rules list [--workspace <path>]`);
    process.exit(1);
  }
}

if (subcommand === "run") {
  const sub = args[1];
  if (sub === "list") {
    try {
      listRuns(args.slice(2));
      process.exit(0);
    } catch (err) {
      console.error(`zana run list: ${err.message || err}`);
      process.exit(1);
    }
  } else {
    console.error(`Usage: zana run list [--limit N] [--workspace <path>]`);
    process.exit(1);
  }
}

if (subcommand === "schedule") {
  const sub = args[1];
  if (sub === "list") {
    try {
      listSchedules(args.slice(2));
      process.exit(0);
    } catch (err) {
      console.error(`zana schedule list: ${err.message || err}`);
      process.exit(1);
    }
  } else {
    console.error(`Usage: zana schedule list [--workspace <path>]`);
    process.exit(1);
  }
}

if (subcommand === "config") {
  const { execFileSync } = require("child_process");
  const daemonBin = path.join(appRoot, "packages", "core", "dist", "bin", "daemon.js");
  try {
    execFileSync(process.execPath, [daemonBin, "config", ...args.slice(1)], { stdio: "inherit" });
  } catch (err) {
    process.exit(err.status || 1);
  }
  process.exit(0);
}

// Subcommands handled asynchronously elsewhere (they call process.exit on completion).
const ASYNC_SUBCOMMANDS = new Set(["ticket", "run", "schedule"]);
const stopAll = subcommand === "stop" && args.includes("--all");

if (subcommand === "headless" || subcommand === "start") {
  launchHeadless(args.slice(1));
} else if (!ASYNC_SUBCOMMANDS.has(subcommand) && !stopAll) {
  // Default: launch headless for the given workspace
  launchHeadless(args);
}

// --- Help ---

function printHelp() {
  console.log(`
Usage: zana [command] [options]

Commands:
  init [path]                            Initialize .zana/ in a project directory
  init wizard [path]                     Guided setup: initialize + register MCP server
  migrate [path]                         Run pending migrations
  status                                 Show running daemon instances
  stop <id|port>                         Stop a running daemon
  stop --all                             Stop all running daemons and clean registry
  config [args...]                       Print or modify module configuration
  ticket list [--status s] [--workspace] List tickets in the active daemon's workspace
  ticket rules list [--workspace <p>]    List loaded automation hook rules + validation warnings
  run list [--limit N]                   List recent agent runs from .zana/runs/
  schedule list                          List schedules in .zana/scheduler/
  headless [path]                        Run zana-daemon in foreground (default)

Options:
  --repair-mcp         With init wizard, overwrite stale zana MCP config
  --help, -h           Show this help
`);
}

function runInitWizard(initArgs) {
  const { initProjectDir, isProjectInitialized } = require(path.join(appRoot, "packages", "core", "dist", "src", "project", "init.js"));
  const { ensureMcpServer, ensureStatusLine } = require(path.join(appRoot, "packages", "mcp", "dist", "src", "claude-settings.js"));

  const target = initArgs.find((arg) => !arg.startsWith("-")) || process.cwd();
  const workspace = path.resolve(target);
  const force = initArgs.includes("--force");
  const repairMcp = initArgs.includes("--repair-mcp");

  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    console.error(`zana init wizard: not a valid directory: ${workspace}`);
    process.exit(1);
  }

  const wasInitialized = isProjectInitialized(workspace);
  if (!wasInitialized || force) {
    initProjectDir(workspace, { force });
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

  const statuslineScript = path.join(appRoot, "packages", "core", "dist", "bin", "statusline.js");
  const statusLineResult = ensureStatusLine({
    scriptPath: statuslineScript,
    repairIfDifferent: repairMcp,
  });

  console.log("\x1b[36mzana init wizard\x1b[0m complete");
  console.log();
  console.log(`  Workspace:      ${workspace}`);
  console.log(`  .zana/:         ${wasInitialized && !force ? "already initialized" : "initialized"}`);
  console.log(`  MCP server:     ${mcpResult.status} (zana)`);
  console.log(`  Status line:    ${statusLineResult.status} (zana)`);
  console.log(`  Claude settings: ${mcpResult.settingsPath}`);
  if (mcpResult.status === "different" && !repairMcp) {
    console.log("  MCP note:       existing zana config differs; rerun with --repair-mcp to overwrite");
  }
  if (statusLineResult.status === "different" && !repairMcp) {
    console.log("  Status note:    existing statusLine differs; rerun with --repair-mcp to overwrite");
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
  const { isProjectInitialized, initProjectDir } = require(path.join(appRoot, "packages", "core", "dist", "src", "project", "init.js"));
  if (!isProjectInitialized(workspace)) {
    initProjectDir(workspace);
  }

  const daemonBin = path.join(appRoot, "packages", "core", "dist", "bin", "daemon.js");
  const daemonArgs = [`--workspace=${workspace}`, ...restArgs.filter((a) => a.startsWith("-"))];

  const child = spawn(process.execPath, [daemonBin, ...daemonArgs], {
    stdio: "inherit",
    env: { ...process.env },
  });
  child.on("exit", (code) => process.exit(code || 0));
}

// --- Status command ---

function printStatus() {
  const daemonsDir = path.join(os.homedir(), ".zana", "daemons");
  if (!fs.existsSync(daemonsDir)) {
    console.log("No daemon(s) running.");
    return;
  }

  const files = fs.readdirSync(daemonsDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("No daemon(s) running.");
    return;
  }

  const alive = [];
  for (const f of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(daemonsDir, f), "utf8"));
      if (isProcessAlive(entry.pid)) {
        alive.push(entry);
      } else {
        try { fs.unlinkSync(path.join(daemonsDir, f)); } catch {}
      }
    } catch {}
  }

  if (alive.length === 0) {
    console.log("No daemon(s) running.");
    return;
  }

  console.log(`\x1b[36m${alive.length} daemon(s) running:\x1b[0m\n`);
  for (const h of alive) {
    const uptime = formatUptime(h.startedAt);
    console.log(`  \x1b[32m●\x1b[0m \x1b[1m${h.id}\x1b[0m  port:${h.port}  pid:${h.pid}  ${uptime}`);
    console.log(`    ${h.workspace}`);
    console.log();
  }
}

// --- Stop command ---

function stopDaemon(idOrPort) {
  if (!idOrPort) {
    console.error("Usage: zana stop <id|port>");
    process.exit(1);
  }

  const daemonsDir = path.join(os.homedir(), ".zana", "daemons");
  if (!fs.existsSync(daemonsDir)) {
    console.error("No daemon(s) running.");
    process.exit(1);
  }

  const files = fs.readdirSync(daemonsDir).filter((f) => f.endsWith(".json"));
  let target = null;

  for (const f of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(daemonsDir, f), "utf8"));
      if (entry.id === idOrPort || String(entry.port) === idOrPort) {
        target = entry;
        break;
      }
    } catch {}
  }

  if (!target) {
    console.error(`Daemon not found: ${idOrPort}`);
    process.exit(1);
  }

  if (!isProcessAlive(target.pid)) {
    console.log(`Daemon ${target.id} is already dead. Cleaning up.`);
    try { fs.unlinkSync(path.join(daemonsDir, `${target.id}.json`)); } catch {}
    return;
  }

  try {
    process.kill(target.pid, "SIGTERM");
    console.log(`\x1b[33mStopped\x1b[0m daemon ${target.id} (pid ${target.pid})`);
  } catch (err) {
    console.error(`Failed to stop daemon ${target.id}: ${err.message}`);
    process.exit(1);
  }
}

// --- Migrate command ---

function runMigrate(restArgs) {
  const { migrate, dryRun } = require(path.join(appRoot, "packages", "core", "dist", "src", "project", "migrate.js"));

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
  console.log(`  Errors:  ${result.errors.length}`);

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.log(`    \x1b[31m!\x1b[0m ${err}`);
    }
  }

  if (result.notes && result.notes.length > 0) {
    console.log(`  Notes:`);
    for (const note of result.notes) {
      console.log(`    - ${note}`);
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

function readAuthToken() {
  const authFile = path.join(os.homedir(), ".zana", "auth.json");
  try {
    const raw = JSON.parse(fs.readFileSync(authFile, "utf8"));
    return raw.token;
  } catch {
    return null;
  }
}

function getFlagValue(restArgs, flag) {
  const idx = restArgs.indexOf(flag);
  if (idx === -1 || idx === restArgs.length - 1) return null;
  return restArgs[idx + 1];
}

function httpGetJson(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); }
            catch (err) { reject(new Error(`bad JSON from ${pathname}: ${err.message}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode} from ${pathname}: ${body.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// --- ticket list command ---

async function listTickets(restArgs) {
  const { findRunningDaemon } = require(path.join(appRoot, "packages", "core", "dist", "src", "daemon", "registry.js"));
  const statusFilter = getFlagValue(restArgs, "--status");
  const workspaceArg = getFlagValue(restArgs, "--workspace");
  const workspace = workspaceArg ? path.resolve(workspaceArg) : process.cwd();

  const daemon = findRunningDaemon(workspace);
  if (!daemon) {
    console.error("no daemon running for this workspace");
    process.exit(1);
  }

  // Hook server is at `port`; HTTP API is at `port + 1` (see core.ts).
  const apiPort = daemon.port + 1;
  const token = readAuthToken();

  const tickets = await httpGetJson(apiPort, "/tickets", token);
  if (!Array.isArray(tickets)) {
    console.error(`unexpected /tickets response: ${JSON.stringify(tickets).slice(0, 200)}`);
    process.exit(1);
  }

  const filtered = statusFilter
    ? tickets.filter((t) => t && t.status === statusFilter)
    : tickets;

  for (const t of filtered) {
    const id = String(t.id || "").slice(0, 8);
    const status = t.status || "?";
    const priority = t.priority || "?";
    const title = t.title || "";
    console.log(`${id} | ${status} | ${priority} | ${title}`);
  }
}

// --- ticket rules list command ---

async function listTicketRules(restArgs) {
  const { findRunningDaemon } = require(path.join(appRoot, "packages", "core", "dist", "src", "daemon", "registry.js"));
  const workspaceArg = getFlagValue(restArgs, "--workspace");
  const workspace = workspaceArg ? path.resolve(workspaceArg) : process.cwd();

  const daemon = findRunningDaemon(workspace);
  if (!daemon) {
    console.error("no daemon running for this workspace");
    process.exit(1);
  }

  const apiPort = daemon.port + 1;
  const token = readAuthToken();

  const data = await httpGetJson(apiPort, "/tickets/rules", token);
  const rules = (data && data.rules) || [];
  const warnings = (data && data.warnings) || [];

  if (rules.length === 0) {
    console.log("No automation rules loaded.");
    return;
  }

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const name = r.name || `idx-${i}`;
    const trig = r.trigger || {};
    const event = trig.event || (trig.status !== undefined ? "ticket:statusChanged (legacy)" : "?");
    const action = r.action || {};
    const profile = action.spawnProfile || (action.type === "workflow" ? `workflow:${action.skillId}` : "?");
    const flags = [];
    if (r.disabled) flags.push("disabled");
    const ruleWarnings = warnings.filter((w) => w.ruleIndex === i);
    if (ruleWarnings.length > 0) flags.push(`${ruleWarnings.length} warning(s)`);
    const flagSuffix = flags.length > 0 ? `  [${flags.join(", ")}]` : "";
    console.log(`${name}  on=${event}  profile=${profile}${flagSuffix}`);
    for (const w of ruleWarnings) {
      console.log(`    ${w.level}: ${w.message}`);
    }
  }
}

// --- run list command ---

function resolveProjectDir(workspace) {
  // Mirror packages/core/src/project/workspace-context.ts:resolveProjectDir
  // — walk up looking for an existing .zana/, stopping at .git or fs root.
  let current = path.resolve(workspace);
  while (true) {
    const candidate = path.join(current, ".zana");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const gitDir = path.join(current, ".git");
    if (fs.existsSync(gitDir)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(workspace, ".zana");
}

function listRuns(restArgs) {
  const limitArg = getFlagValue(restArgs, "--limit");
  const workspaceArg = getFlagValue(restArgs, "--workspace");
  const limit = limitArg ? Math.max(1, parseInt(limitArg, 10) || 0) : 20;
  const workspace = workspaceArg ? path.resolve(workspaceArg) : process.cwd();

  const projectDir = resolveProjectDir(workspace);
  const runsDir = path.join(projectDir, "runs");

  if (!fs.existsSync(runsDir)) {
    console.log("(no runs directory)");
    return;
  }

  const files = fs.readdirSync(runsDir).filter((f) => f.endsWith(".json"));
  const entries = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(runsDir, f), "utf8"));
      entries.push(raw);
    } catch {
      // Skip unreadable / corrupt files quietly.
    }
  }

  entries.sort((a, b) => {
    const aT = a.terminatedAt ? new Date(a.terminatedAt).getTime() : 0;
    const bT = b.terminatedAt ? new Date(b.terminatedAt).getTime() : 0;
    return bT - aT;
  });

  for (const r of entries.slice(0, limit)) {
    const id = String(r.id || "").slice(0, 8);
    const profile = r.profileId || "?";
    const state = r.state || "?";
    const tokIn = r.tokensIn ?? 0;
    const tokOut = r.tokensOut ?? 0;
    const cost = typeof r.costUsd === "number" ? r.costUsd.toFixed(4) : "0.0000";
    const dur = r.durationMs ?? 0;
    const term = r.terminatedAt || "-";
    console.log(`${id} | ${profile} | ${state} | tok=${tokIn}/${tokOut} | $${cost} | ${dur}ms | ${term}`);
  }
}

// --- stop --all command ---

function getDaemonsDir() {
  // Allow env override so tests can drive against a tmp registry without
  // touching the user's real ~/.zana/daemons.
  return process.env.ZANA_DAEMONS_DIR || path.join(os.homedir(), ".zana", "daemons");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopAllDaemons() {
  const daemonsDir = getDaemonsDir();
  if (!fs.existsSync(daemonsDir)) return 0;

  const files = fs.readdirSync(daemonsDir).filter((f) => f.endsWith(".json"));
  const entries = [];
  for (const f of files) {
    try {
      entries.push(JSON.parse(fs.readFileSync(path.join(daemonsDir, f), "utf8")));
    } catch {
      // ignore corrupt entries — we'll still try to clean them up below
    }
  }

  // First pass: SIGTERM anything that's alive.
  const aliveAfterTerm = [];
  for (const e of entries) {
    if (e?.pid && isProcessAlive(e.pid)) {
      try { process.kill(e.pid, "SIGTERM"); } catch {}
      aliveAfterTerm.push(e);
    }
  }

  // Give each up to 2s to exit cleanly.
  if (aliveAfterTerm.length > 0) {
    await delay(2000);
    for (const e of aliveAfterTerm) {
      if (isProcessAlive(e.pid)) {
        try { process.kill(e.pid, "SIGKILL"); } catch {}
      }
    }
  }

  // Always remove every registry file (whether the kill succeeded or not).
  let removed = 0;
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(daemonsDir, f));
      removed++;
    } catch {}
  }
  return removed;
}

// --- schedule list command ---

function formatRelativeFuture(iso) {
  if (!iso) return "?";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "?";
  const diff = t - Date.now();
  if (diff <= 0) return "due";
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `in ${hr}h`;
  const day = Math.round(hr / 24);
  return `in ${day}d`;
}

function listSchedules(restArgs) {
  const workspaceArg = getFlagValue(restArgs, "--workspace");
  const workspace = workspaceArg ? path.resolve(workspaceArg) : process.cwd();
  const projectDir = resolveProjectDir(workspace);
  const schedulerDir = path.join(projectDir, "scheduler");

  if (!fs.existsSync(schedulerDir)) {
    console.log("(no scheduler directory)");
    return;
  }

  const { parseYaml } = require(path.join(
    appRoot, "packages", "work", "dist", "src", "scheduling", "yaml-format.js"
  ));

  const files = fs.readdirSync(schedulerDir);
  const byId = new Map();

  // YAML files first (preferred); JSON fills in only if no YAML for that id.
  for (const f of files) {
    if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
    if (f.endsWith(".yml.example") || f.endsWith(".yaml.example")) continue;
    try {
      const content = fs.readFileSync(path.join(schedulerDir, f), "utf8");
      const parsed = parseYaml(content);
      if (parsed && parsed.id) byId.set(parsed.id, parsed);
    } catch {}
  }
  for (const f of files) {
    if (!f.endsWith(".json") || f.endsWith(".history.json")) continue;
    try {
      const content = fs.readFileSync(path.join(schedulerDir, f), "utf8");
      const parsed = JSON.parse(content);
      if (parsed && parsed.id && !byId.has(parsed.id)) byId.set(parsed.id, parsed);
    } catch {}
  }

  const schedules = Array.from(byId.values());
  if (schedules.length === 0) {
    console.log("(no schedules)");
    return;
  }

  for (const s of schedules) {
    const id = s.id;
    const enabled = s.enabled ? "enabled" : "disabled";
    const ms = s.schedule?.intervalMs;
    const everyMin = typeof ms === "number" && ms > 0
      ? Math.round(ms / 60000)
      : (s.schedule?.every ? s.schedule.every : "?");
    const next = formatRelativeFuture(s.status?.nextRunAt);
    const runCount = s.status?.runCount ?? 0;
    const name = s.name || "";
    const lastResult = s.status?.lastRunResult;
    const lastResultStr = lastResult ? ` last=${lastResult}` : "";
    const everyStr = typeof everyMin === "number" ? `every ${everyMin}m` : `every ${everyMin}`;
    console.log(
      `${id} | ${enabled} | ${everyStr} | next ${next} | runCount ${runCount} | ${name}${lastResultStr}`
    );
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
