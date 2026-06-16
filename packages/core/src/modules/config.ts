import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const DEFAULTS = {
  modules: {},
  system: { initTimeout: 10000, suspendTimeout: 5000, hotReload: false, maxConcurrentAgents: 10, cpuGateEnabled: false, cpuLoadThreshold: 0.8, cpuLoadHardCap: 2.0, agentTimeoutMinutes: 10, spawnThrottleStreakLimit: 5, zombieReaperEnabled: true, zombieReaperIntervalMs: 60000, zombieReaperGraceMs: 300000, ticketSweeperEnabled: true, ticketSweeperIntervalMs: 3600000, ticketStaleThresholdMs: 86400000, transientRetryMaxAttempts: 3, transientRetryBackoffMs: [30000, 120000, 480000] },
};

let configPath = null;
let lastHash = null;
let pollTimer = null;
let currentConfig = null;
let changeListeners = [];

export function setConfigPath(p) {
  configPath = p;
}

function getConfigPath() {
  if (!configPath) {
    const workspace = require("../project/workspace-context");
    configPath = path.join(workspace.getProjectDir(), "config.json");
  }
  return configPath;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function load() {
  const p = getConfigPath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    currentConfig = mergeDefaults(parsed);
  } catch {
    currentConfig = { ...DEFAULTS, modules: {} };
  }
  lastHash = hashConfig(currentConfig);
  return currentConfig;
}

export function save(config) {
  const p = getConfigPath();
  ensureDir(path.dirname(p));
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmp, p);
  currentConfig = config;
  lastHash = hashConfig(config);
}

function mergeDefaults(config) {
  return {
    modules: config.modules || {},
    system: { ...DEFAULTS.system, ...(config.system || {}) },
  };
}

function hashConfig(config) {
  return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function get() {
  if (!currentConfig) load();
  return currentConfig;
}

export function getModuleConfig(moduleId) {
  const cfg = get();
  return cfg.modules[moduleId] || { enabled: true, config: {} };
}

export function setModuleConfig(moduleId, data) {
  const cfg = get();
  cfg.modules[moduleId] = { ...cfg.modules[moduleId], ...data };
  save(cfg);
}

export function isModuleEnabled(moduleId) {
  const mc = getModuleConfig(moduleId);
  return mc.enabled !== false;
}

export function applySchemaDefaults(moduleId, schema) {
  if (!schema || typeof schema !== "object") return;
  const cfg = get();
  if (!cfg.modules[moduleId]) cfg.modules[moduleId] = { enabled: true, config: {} };
  const mc = cfg.modules[moduleId];
  if (!mc.config) mc.config = {};
  for (const [key, def] of Object.entries(schema)) {
    if (mc.config[key] === undefined && def.default !== undefined) {
      mc.config[key] = def.default;
    }
  }
  currentConfig = cfg;
}

export function onConfigChanged(listener) {
  changeListeners.push(listener);
  return () => {
    changeListeners = changeListeners.filter((l) => l !== listener);
  };
}

export function startWatching() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    const p = getConfigPath();
    let raw;
    try { raw = fs.readFileSync(p, "utf8"); }
    catch { return; }

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return; }

    const newConfig = mergeDefaults(parsed);
    const newHash = hashConfig(newConfig);
    if (newHash === lastHash) return;

    const oldConfig = currentConfig;
    currentConfig = newConfig;
    lastHash = newHash;

    for (const listener of changeListeners) {
      try { listener(newConfig, oldConfig); }
      catch (err) {
        process.stderr.write(`[module-config] change listener error: ${err.message}\n`);
      }
    }
  }, 2000);
  if (pollTimer.unref) pollTimer.unref();
}

export function stopWatching() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  changeListeners = [];
}

export const startWatcher = startWatching;
export const stopWatcher = stopWatching;