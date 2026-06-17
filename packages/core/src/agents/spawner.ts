import { spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as configMod from "../config";
import * as workspaceContext from "../project/workspace-context";
import { lazyRequire } from "../util/lazy-require";
type SkillStoreModule = typeof import("@zana-ai/extras/dist/src/settings/skill-store");
type SettingsStoreModule = typeof import("@zana-ai/extras/dist/src/settings/store");
const skillStore = lazyRequire<SkillStoreModule>(() => require("@zana-ai/extras").settings.skillStore);
const settingsStore = lazyRequire<SettingsStoreModule>(() => require("@zana-ai/extras").settings.store);

export function findClaude() {
  if (process.env.ZANA_WORKER_BIN) return process.env.ZANA_WORKER_BIN;

  const localBin = path.join(os.homedir(), ".local", "bin", "claude");
  if (fs.existsSync(localBin)) return localBin;

  const paths = (process.env.PATH || "").split(":");
  for (const dir of paths) {
    const candidate = path.join(dir, "claude");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "claude";
}

const VALID_PERMISSION_MODES = ["default", "plan", "auto", "acceptEdits", "bypassPermissions", "dontAsk"];
const VALID_EFFORT_LEVELS = ["low", "medium", "high", "max"];

const ENV_PASSTHROUGH_PREFIXES = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_", "NODE_", "NPM_", "VOLTA_", "NVM_", "ZANA_", "CLAUDE_", "XDG_"];

function filterEnvForChild(env) {
  const filtered = {};
  for (const [key, value] of Object.entries(env)) {
    if (ENV_PASSTHROUGH_PREFIXES.some((p) => key === p || key.startsWith(p))) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function sanitizeArg(value) {
  if (typeof value !== "string") return String(value);
  return value.replace(/[\x00-\x1f\x7f]/g, "");
}

// Worker profiles need to know how to interact with the ticket lifecycle when
// the orchestrator hands them a ticketId in their prompt. Without this, only
// orchestrator profiles ever call zana_ticket_claim/complete, so when the
// orchestrator dies mid-run the ticket is orphaned forever (every "0.1.3 doc"
// ticket in the backlog as of 2026-06-04 was such an orphan). Skip
// orchestrator-shaped profiles — they already document the full workflow.
function ticketLifecyclePreamble(profile) {
  const id = profile?.id || "";
  if (id.includes("orchestrator") || id === "swarm-master") return "";
  return [
    "--- TICKET LIFECYCLE ---",
    "If your prompt includes a ticketId, you are responsible for the ticket's status:",
    "1. Claim it on start: call mcp__zana__zana_ticket_claim with { ticketId, agentName: <your name> }.",
    "2. On success: call mcp__zana__zana_ticket_complete with { ticketId, resultSummary: <what you did> }.",
    "3. On failure (cannot finish, blocked, validation broke): call mcp__zana__zana_ticket_update_status with { ticketId, status: \"blocked\" } and add a comment via mcp__zana__zana_ticket_comment explaining why.",
    "Do NOT leave a claimed ticket open — orphaned tickets cannot be reconciled and waste backlog slots.",
  ].join("\n");
}

function validateProfile(profile) {
  if (profile.permissionMode && !VALID_PERMISSION_MODES.includes(profile.permissionMode)) {
    throw new Error(`invalid permissionMode: ${profile.permissionMode}`);
  }
  if (profile.effortLevel && !VALID_EFFORT_LEVELS.includes(profile.effortLevel)) {
    throw new Error(`invalid effortLevel: ${profile.effortLevel}`);
  }
  if (profile.model && !/^[a-zA-Z0-9._:/-]+$/.test(profile.model)) {
    throw new Error(`invalid model name: ${profile.model}`);
  }
  if (profile.allowedTools) {
    for (const tool of profile.allowedTools) {
      if (typeof tool !== "string" || /[\x00-\x1f\x7f]/.test(tool)) {
        throw new Error(`invalid tool name in allowedTools: ${tool}`);
      }
    }
  }
  if (profile.disallowedTools) {
    for (const tool of profile.disallowedTools) {
      if (typeof tool !== "string" || /[\x00-\x1f\x7f]/.test(tool)) {
        throw new Error(`invalid tool name in disallowedTools: ${tool}`);
      }
    }
  }
  if (profile.maxBudgetUsd != null) {
    const budget = Number(profile.maxBudgetUsd);
    if (isNaN(budget) || budget < 0 || budget > 10000) {
      throw new Error(`invalid maxBudgetUsd: ${profile.maxBudgetUsd}`);
    }
  }
}

export function buildClaudeArgs(profile, options = {}) {
  validateProfile(profile);
  const args = [];

  if (options.name || profile.displayName) {
    args.push("--name", sanitizeArg(options.name || profile.displayName));
  }

  // Resume an existing claude conversation (transient-error retry / crash
  // recovery). Additive: omitted unless the caller passes a session id, so
  // the default cold-start path is unchanged.
  if (options.resumeSessionId) {
    args.push("--resume", sanitizeArg(options.resumeSessionId));
  }

  if (profile.systemPrompt) {
    args.push("--system-prompt", sanitizeArg(profile.systemPrompt));
  }

  const lifecycleBlock = ticketLifecyclePreamble(profile);
  const skillInstructions = skillStore.getInstructionsForProfile(profile.id);
  const skillsBlock = skillInstructions.length > 0
    ? "--- ZANA SKILLS ---\n" + skillInstructions.join("\n\n")
    : "";
  const appendParts = [
    profile.appendSystemPrompt || "",
    lifecycleBlock,
    skillsBlock,
  ].filter((s) => s && s.length > 0);
  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  if (profile.model) {
    args.push("--model", profile.model);
  }

  if (profile.effortLevel) {
    args.push("--effort", profile.effortLevel);
  }

  if (profile.permissionMode) {
    args.push("--permission-mode", profile.permissionMode);
  }

  if (profile.allowedTools && profile.allowedTools.length > 0) {
    args.push("--allowed-tools", ...profile.allowedTools);
  }

  if (profile.disallowedTools && profile.disallowedTools.length > 0) {
    args.push("--disallowed-tools", ...profile.disallowedTools);
  }

  if (profile.maxBudgetUsd) {
    args.push("--max-budget-usd", String(profile.maxBudgetUsd));
  }

  // MCP wiring. A profile may carry an explicit `mcpConfig`; otherwise — unless
  // it opts out with `noZanaMcp: true` — a headless worker gets the zana MCP
  // server injected by default so it can report ticket progress back
  // (zana_ticket_update / _verdict / _comment). Without this the auto-implement
  // loop silently stalls: the worker is TOLD to call zana_ticket_* but the tools
  // aren't registered in the child, so the ticket sits in-progress forever with
  // no error. Opt-out (not opt-in) because forgetting it fails silently.
  const effectiveProfile =
    profile.mcpConfig || profile.noZanaMcp
      ? profile
      : { ...profile, mcpConfig: defaultZanaMcpConfig() };

  if (effectiveProfile.mcpConfig) {
    const configPath = writeTempMcpConfig(effectiveProfile, {
      terminalId: options.terminalId,
      agentName: options.name,
      profileId: profile.id,
    });
    if (configPath) {
      args.push("--mcp-config", configPath);
    }
    if (effectiveProfile.strictMcpConfig) {
      args.push("--strict-mcp-config");
    }
  }

  return args;
}

// The zana MCP server stanza injected by default into headless workers. Points
// at the orchestrator-mcp shim (packages/server), which delegates to the full
// MCP server and talks to THIS daemon over the hook port. writeTempMcpConfig
// resolves the __ORCHESTRATOR_MCP_PATH__ placeholder and stamps the
// ZANA_PORT / ZANA_TERMINAL_ID / ZANA_AGENT_NAME / ZANA_PROFILE_ID env.
function defaultZanaMcpConfig() {
  return {
    zana: {
      command: process.execPath,
      args: ["__ORCHESTRATOR_MCP_PATH__"],
    },
  };
}

function sanitizePathSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

// The orchestrator-mcp shim lives in @zana-ai/server (NOT core). Resolve it via
// the package so it works regardless of the consumer's dist layout; fall back to
// the on-disk monorepo path if the package entry can't be resolved.
function resolveOrchestratorMcpPath() {
  try {
    return require.resolve("@zana-ai/server/dist/src/api/orchestrator-mcp.js");
  } catch {
    return path.join(__dirname, "..", "..", "..", "..", "server", "dist", "src", "api", "orchestrator-mcp.js");
  }
}

function writeTempMcpConfig(profile, options = {}) {
  if (!profile.mcpConfig) return null;
  const dir = workspaceContext.isInitialized()
    ? workspaceContext.getProjectPaths().tmpDir
    : path.join(configMod.ZANA_DIR, "tmp");
  fs.mkdirSync(dir, { recursive: true });

  // Resolve placeholders in MCP config
  const resolved = JSON.parse(JSON.stringify(profile.mcpConfig));
  const orchestratorMcpPath = resolveOrchestratorMcpPath();
  for (const [, server] of Object.entries(resolved)) {
    if (server.args) {
      server.args = server.args.map((arg) =>
        arg === "__ORCHESTRATOR_MCP_PATH__" ? orchestratorMcpPath : arg
      );
    }
    if (!server.env) server.env = {};
    if (server.args?.includes(orchestratorMcpPath)) {
      server.env.ZANA_PORT = String(process.env.ZANA_HOOK_PORT || 47400);
      server.env.ZANA_ID = process.env.ZANA_ID || "default";
      if (options.terminalId) {
        server.env.ZANA_TERMINAL_ID = options.terminalId;
      }
      if (options.agentName) {
        server.env.ZANA_AGENT_NAME = options.agentName;
      }
      if (options.profileId) {
        server.env.ZANA_PROFILE_ID = options.profileId;
      }
      if (process.env.ZANA_MASTER_PORT) {
        server.env.ZANA_MASTER_PORT = process.env.ZANA_MASTER_PORT;
      }
      // Only master daemon's agents get master mode tools
      if (!process.env.ZANA_ROLE || process.env.ZANA_ROLE !== "sub") {
        server.env.ZANA_MASTER_MODE = "true";
      }
    }
  }

  const configPath = path.join(dir, `mcp-${sanitizePathSegment(profile.id)}-${sanitizePathSegment(options.terminalId || "default")}.json`);
  const config = { mcpServers: resolved };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

export function buildInteractiveCommand(profile, options = {}) {
  const claudePath = findClaude();
  const args = buildClaudeArgs(profile, options);
  return { command: claudePath, args };
}

export function spawnHeadless(profile, options = {}) {
  const claudePath = findClaude();

  const headlessProfile = { ...profile };
  // Spawned workers are non-interactive children — there's no human at the
  // other end to answer permission prompts, so without bypass they hang.
  // Profile can opt in to a stricter mode by setting permissionMode explicitly.
  if (!headlessProfile.permissionMode) {
    headlessProfile.permissionMode = "bypassPermissions";
  }

  const args = [
    "--output-format", "stream-json",
    "--verbose",
    ...buildClaudeArgs(headlessProfile, options),
  ];

  if (!options.multiTurn) {
    if (options.prompt) {
      args.push("-p", options.prompt);
    } else {
      args.unshift("-p");
    }
  } else {
    args.splice(2, 0, "--input-format", "stream-json");
    if (options.prompt) {
      args.push(options.prompt);
    }
  }

  const cwd = options.cwd || profile.defaultCwd || os.homedir();

  const resolvedProvider = settingsStore.providerFromModel(profile.model) || settingsStore.getDefaultProvider();
  let llmEnv = settingsStore.getEnvForProvider(resolvedProvider);
  if (Object.keys(llmEnv).length === 0 && resolvedProvider !== settingsStore.getDefaultProvider()) {
    llmEnv = settingsStore.getEnvForProvider(settingsStore.getDefaultProvider());
  }

  const workspaceEnv = {};
  if (workspaceContext.isInitialized()) {
    workspaceEnv.ZANA_WORKSPACE = workspaceContext.getWorkspaceRoot();
    workspaceEnv.ZANA_DIR = workspaceContext.getProjectDir();
  }

  const child = spawn(claudePath, args, {
    cwd,
    env: {
      ...filterEnvForChild(process.env),
      ...llmEnv,
      ...workspaceEnv,
      ZANA_TERMINAL_ID: options.terminalId || "",
    },
    stdio: ["pipe", "pipe", "pipe"],
    // detached makes the child a process-group leader (pgid === pid) on POSIX so
    // killAgent() can signal the whole tree — the claude CLI spawns its own
    // children (MCP servers, tool subprocesses), and a bare child.kill() would
    // orphan those. We do NOT unref(), so the daemon still waits on the child
    // normally; orphans from a daemon crash are swept by the zombie-reaper.
    detached: process.platform !== "win32",
  });

  return child;
}

export function spawnOneShot(profile, prompt, options = {}) {
  const claudePath = findClaude();
  const oneShotProfile = { ...profile };
  if (!oneShotProfile.permissionMode) {
    oneShotProfile.permissionMode = "bypassPermissions";
  }
  const args = [
    ...buildClaudeArgs(oneShotProfile, options),
    "-p",
    prompt,
  ];

  const cwd = options.cwd || profile.defaultCwd || os.homedir();
  const timeout = options.timeout || 60000;

  const resolvedProvider = settingsStore.providerFromModel(profile.model) || settingsStore.getDefaultProvider();
  let llmEnv = settingsStore.getEnvForProvider(resolvedProvider);
  if (Object.keys(llmEnv).length === 0 && resolvedProvider !== settingsStore.getDefaultProvider()) {
    llmEnv = settingsStore.getEnvForProvider(settingsStore.getDefaultProvider());
  }

  const workspaceEnv = {};
  if (workspaceContext.isInitialized()) {
    workspaceEnv.ZANA_WORKSPACE = workspaceContext.getWorkspaceRoot();
    workspaceEnv.ZANA_DIR = workspaceContext.getProjectDir();
  }

  return new Promise((resolve) => {
    const child = spawn(claudePath, args, {
      cwd,
      env: {
        ...filterEnvForChild(process.env),
        ...llmEnv,
        ...workspaceEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeout);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", () => {
      // Ignore stderr for one-shot mode
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({
        output: output.trim(),
        exitCode: killed ? 124 : (code ?? 1),
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        output: `spawn error: ${err.message}`,
        exitCode: 1,
      });
    });
  });
}

