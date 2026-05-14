import { spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as configMod from "../config";
import * as workspaceContext from "../project/workspace-context";
const skillStore: any = new Proxy({}, { get: (_t, p) => require("@zana/extras").settings.skillStore[p] });
const settingsStore: any = new Proxy({}, { get: (_t, p) => require("@zana/extras").settings.store[p] });

export function findClaude() {
  const localBin = path.join(os.homedir(), ".local", "bin", "claude");
  if (fs.existsSync(localBin)) return localBin;

  const paths = (process.env.PATH || "").split(":");
  for (const dir of paths) {
    const candidate = path.join(dir, "claude");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "claude";
}

const VALID_PERMISSION_MODES = ["default", "plan", "auto", "trust", "bypassPermissions"];
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

  if (profile.systemPrompt) {
    args.push("--system-prompt", sanitizeArg(profile.systemPrompt));
  }

  if (profile.appendSystemPrompt) {
    const instructions = skillStore.getInstructionsForProfile(profile.id);
    if (instructions.length > 0) {
      const skillsBlock = "\n\n--- ZANA SKILLS ---\n" + instructions.join("\n\n");
      args.push("--append-system-prompt", profile.appendSystemPrompt + skillsBlock);
    } else {
      args.push("--append-system-prompt", profile.appendSystemPrompt);
    }
  } else {
    const instructions = skillStore.getInstructionsForProfile(profile.id);
    if (instructions.length > 0) {
      args.push("--append-system-prompt", "--- ZANA SKILLS ---\n" + instructions.join("\n\n"));
    }
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

  if (profile.mcpConfig) {
    const configPath = writeTempMcpConfig(profile, {
      terminalId: options.terminalId,
      agentName: options.name,
    });
    if (configPath) {
      args.push("--mcp-config", configPath);
    }
    if (profile.strictMcpConfig) {
      args.push("--strict-mcp-config");
    }
  }

  return args;
}

function sanitizePathSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function writeTempMcpConfig(profile, options = {}) {
  if (!profile.mcpConfig) return null;
  const dir = configMod.TMP_DIR;
  fs.mkdirSync(dir, { recursive: true });

  // Resolve placeholders in MCP config
  const resolved = JSON.parse(JSON.stringify(profile.mcpConfig));
  const orchestratorMcpPath = path.join(__dirname, "..", "api", "orchestrator-mcp.js");
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
  if (!options.multiTurn && !headlessProfile.permissionMode) {
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
    args.splice(1, 0, "--input-format", "stream-json");
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
  });

  return child;
}

export function spawnOneShot(profile, prompt, options = {}) {
  const claudePath = findClaude();
  const args = [
    ...buildClaudeArgs(profile, options),
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

