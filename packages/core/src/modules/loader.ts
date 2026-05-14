import * as fs from "node:fs";
import * as path from "node:path";
import * as moduleConfig from "./config";

const MODULES_DIR = path.resolve(__dirname, "..", "modules");
const INIT_TIMEOUT = 10000;
const SUSPEND_TIMEOUT = 5000;
const SHUTDOWN_TIMEOUT = 3000;

const modules = new Map();
const loadOrder = [];
const routeRegistry = new Map();
let lockPath = null;
let initialized = false;
let coreModulesRef = null;

function log(msg) { process.stderr.write(`[module-loader] ${msg}\n`); }

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function getLockPath() {
  if (lockPath) return lockPath;
  const workspace = require("../project/workspace-context");
  lockPath = path.join(workspace.getHiveDir(), "modules.lock");
  return lockPath;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function discoverModules() {
  if (!fs.existsSync(MODULES_DIR)) return [];
  const entries = fs.readdirSync(MODULES_DIR, { withFileTypes: true });
  const found = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(MODULES_DIR, entry.name);
    const manifestPath = path.join(dir, "module.json");
    if (!fs.existsSync(manifestPath)) continue;

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
    catch (err) {
      log(`invalid manifest in ${entry.name}: ${err.message}`);
      continue;
    }

    if (!manifest.id || !manifest.name || !manifest.version || !manifest.main) {
      log(`skipping ${entry.name}: missing required fields (id, name, version, main)`);
      continue;
    }

    const mainFile = path.join(dir, manifest.main);
    if (!fs.existsSync(mainFile)) {
      log(`skipping ${manifest.id}: main file "${manifest.main}" not found`);
      continue;
    }

    found.push({ manifest, dir, mainFile });
  }

  return found;
}

function topoSort(discovered) {
  const graph = new Map();
  const byId = new Map();

  for (const entry of discovered) {
    graph.set(entry.manifest.id, entry.manifest.dependencies || []);
    byId.set(entry.manifest.id, entry);
  }

  const sorted = [];
  const visited = new Set();
  const visiting = [];

  function visit(id) {
    if (visited.has(id)) return;
    const idx = visiting.indexOf(id);
    if (idx !== -1) {
      const cycle = visiting.slice(idx).concat(id);
      throw new Error(`circular dependency: ${cycle.join(" → ")}`);
    }
    visiting.push(id);
    const deps = graph.get(id) || [];
    for (const dep of deps) {
      if (!byId.has(dep)) {
        throw new Error(`module "${id}" depends on unknown module "${dep}"`);
      }
      visit(dep);
    }
    // Also include optional dependencies that are present
    const optDeps = byId.get(id)?.manifest.optionalDependencies || [];
    for (const dep of optDeps) {
      if (byId.has(dep)) {
        // Add edge only if the optional module exists
        visit(dep);
      }
    }
    visiting.pop();
    visited.add(id);
    sorted.push(byId.get(id));
  }

  for (const id of graph.keys()) {
    visit(id);
  }

  return sorted;
}

function buildContext(moduleId, manifest) {
  const eventBusService = require("../events/service");
  const workspace = require("../project/workspace-context");
  const { ZANA_DIR } = require("./config");

  const projectStoreDir = path.join(workspace.getHiveDir(), moduleId);
  const globalStoreDir = path.join(ZANA_DIR, "modules", moduleId);

  const subs = [];
  const busOn = (filter, cb) => {
    const unsub = eventBusService.subscribe(filter, cb);
    subs.push(unsub);
    return unsub;
  };

  const ctx = {
    moduleId,
    bus: {
      emit: (type, payload, tags) => eventBusService.emit(type, payload, tags),
      on: busOn,
      query: (filter, limit) => eventBusService.query(filter, limit),
    },
    storage: {
      project: projectStoreDir,
      global: globalStoreDir,
      resolve(sub) { ensureDir(projectStoreDir); return path.join(projectStoreDir, sub); },
      resolveGlobal(sub) { ensureDir(globalStoreDir); return path.join(globalStoreDir, sub); },
    },
    config: moduleConfig.getModuleConfig(moduleId).config || {},
    logger: {
      info: (msg) => process.stderr.write(`[module:${moduleId}] ${msg}\n`),
      warn: (msg) => process.stderr.write(`[module:${moduleId}] WARN ${msg}\n`),
      error: (msg) => process.stderr.write(`[module:${moduleId}] ERROR ${msg}\n`),
      debug: (msg) => { if (process.env.ZANA_DEBUG) process.stderr.write(`[module:${moduleId}] DEBUG ${msg}\n`); },
    },
    getModule(id) {
      const record = modules.get(id);
      if (!record) return null;
      return record.api || {};
    },
    workspace: {
      root: () => workspace.getWorkspaceRoot(),
      hiveDir: () => workspace.getHiveDir(),
      paths: () => workspace.getProjectPaths(),
    },
    hive: {
      agents: {
        list: () => coreModulesRef?.agentManager?.listAgents() || [],
        get: (id) => (coreModulesRef?.agentManager?.listAgents() || []).find((a) => a.id === id) || null,
        spawn: (profileOrId, opts) => {
          if (!coreModulesRef?.agentManager) return null;
          let profile = profileOrId;
          if (typeof profileOrId === "string") {
            const profileStore = require("../agents/profile-store");
            profile = profileStore.getProfile(profileOrId) || profileStore.getProfile(`built-in-${profileOrId}`);
            if (!profile) return null;
          }
          return coreModulesRef.agentManager.spawnHeadlessAgent(profile, opts);
        },
        kill: (id) => coreModulesRef?.agentManager?.killAgent(id),
      },
      tickets: {
        list: (filter) => coreModulesRef?.ticketService?.listTickets(filter) || [],
        get: (id) => coreModulesRef?.ticketService?.getTicket(id) || null,
        create: (data) => coreModulesRef?.ticketService?.createTicket(data),
        update: (id, data) => coreModulesRef?.ticketService?.updateTicket(id, data),
      },
    },
    _subscriptions: subs,
    exposeRoute(routePath, handler) {
      const key = `/m/${moduleId}/${routePath.replace(/^\//, "")}`;
      routeRegistry.set(key, { moduleId, handler });
    },
  };

  return ctx;
}

function writeLock(state) {
  const p = getLockPath();
  ensureDir(path.dirname(p));
  const data = { pid: process.pid, started: Date.now(), modules: state };
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function readLock() {
  const p = getLockPath();
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

function removeLock() {
  const p = getLockPath();
  try { fs.unlinkSync(p); } catch {}
}

function validateEventContracts(registry) {
  const allEmits = new Set();
  const allSubscribes = new Map(); // event -> [moduleId]
  for (const [id, { manifest }] of registry) {
    for (const e of manifest.events?.emits || []) allEmits.add(e);
    for (const e of manifest.events?.subscribes || []) {
      if (!allSubscribes.has(e)) allSubscribes.set(e, []);
      allSubscribes.get(e).push(id);
    }
  }
  for (const [event, subscribers] of allSubscribes) {
    if (!allEmits.has(event)) {
      console.warn(`[module-loader] warning: ${subscribers.join(", ")} subscribe to "${event}" but no module declares it emits this event`);
    }
  }
}

export async function init(coreModules) {
  if (initialized) return;
  if (coreModules) coreModulesRef = coreModules;

  const cfg = moduleConfig.load();
  const timeouts = cfg.system || {};
  const initTimeout = timeouts.initTimeout || INIT_TIMEOUT;

  const discovered = discoverModules();
  if (discovered.length === 0) {
    initialized = true;
    return;
  }

  let sorted;
  try {
    sorted = topoSort(discovered);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    return;
  }

  const lockState = readLock();
  let needsRecovery = lockState !== null;
  if (needsRecovery && lockState.pid) {
    try { process.kill(lockState.pid, 0); needsRecovery = true; }
    catch { needsRecovery = false; removeLock(); log("stale lock removed (PID dead)"); }
  }

  // Phase 1: init in dependency order
  for (const entry of sorted) {
    const { manifest, dir, mainFile } = entry;
    if (!moduleConfig.isModuleEnabled(manifest.id)) {
      log(`skipping disabled module: ${manifest.id}`);
      continue;
    }

    let mod;
    try { mod = require(mainFile); }
    catch (err) {
      log(`failed to require ${manifest.id}: ${err.message}`);
      continue;
    }

    const ctx = buildContext(manifest.id, manifest);
    moduleConfig.applySchemaDefaults(manifest.id, manifest.configSchema);

    if (needsRecovery && typeof mod.recover === "function") {
      try {
        const modLockState = lockState.modules?.[manifest.id];
        await withTimeout(mod.recover(modLockState || {}, ctx), initTimeout, `${manifest.id}.recover`);
        log(`recovered ${manifest.id}`);
      } catch (err) {
        log(`recover failed for ${manifest.id}: ${err.message}`);
      }
    }

    let api = {};
    if (typeof mod.init === "function") {
      try {
        api = await withTimeout(mod.init(ctx), initTimeout, `${manifest.id}.init`) || {};
      } catch (err) {
        log(`init failed for ${manifest.id}: ${err.message}`);
        continue;
      }
    }

    const record = { id: manifest.id, manifest, dir, mod, ctx, api, status: "initialized" };
    modules.set(manifest.id, record);
    loadOrder.push(manifest.id);

    // Register module MCP tools
    if (manifest.api?.mcp?.length > 0) {
      const moduleToolRegistry = require("./tool-registry");
      const tools = manifest.api.mcp.map(tool => ({
        ...tool,
        name: `zana_${manifest.id}_${tool.name}`,
        moduleId: manifest.id,
      }));
      moduleToolRegistry.registerModuleTools(manifest.id, tools);
    }
  }

  // Write lock now that modules are initialized
  const lockModules = {};
  for (const [id, record] of modules) {
    lockModules[id] = { status: record.status, initTime: Date.now() };
  }
  writeLock(lockModules);

  // Phase 2: ready() in parallel
  const readyPromises = [];
  for (const id of loadOrder) {
    const record = modules.get(id);
    if (typeof record.mod.ready === "function") {
      readyPromises.push(
        withTimeout(record.mod.ready(record.ctx), initTimeout, `${id}.ready`)
          .then(() => { record.status = "ready"; })
          .catch((err) => { log(`ready failed for ${id}: ${err.message}`); })
      );
    } else {
      record.status = "ready";
    }
  }
  await Promise.all(readyPromises);

  // Watch config for changes
  moduleConfig.onConfigChanged((newCfg, oldCfg) => {
    for (const [id, record] of modules) {
      const newMc = newCfg.modules?.[id]?.config || {};
      const oldMc = oldCfg.modules?.[id]?.config || {};
      if (JSON.stringify(newMc) !== JSON.stringify(oldMc)) {
        if (typeof record.mod.onConfigChanged === "function") {
          try { record.mod.onConfigChanged(newMc, oldMc); }
          catch (err) { log(`onConfigChanged error for ${id}: ${err.message}`); }
        }
      }
    }
  });
  moduleConfig.startWatching();

  validateEventContracts(modules);

  initialized = true;
  log(`loaded ${modules.size} module(s)`);
}

export async function shutdown() {
  if (!initialized) return;

  moduleConfig.stopWatching();

  // Reverse order: suspend then shutdown
  const reversed = [...loadOrder].reverse();

  for (const id of reversed) {
    const record = modules.get(id);
    if (!record) continue;

    if (typeof record.mod.suspend === "function") {
      try {
        await withTimeout(record.mod.suspend(), SUSPEND_TIMEOUT, `${id}.suspend`);
      } catch (err) {
        log(`suspend timeout for ${id}: ${err.message}`);
      }
    }

    if (typeof record.mod.shutdown === "function") {
      try {
        await withTimeout(record.mod.shutdown(), SHUTDOWN_TIMEOUT, `${id}.shutdown`);
      } catch (err) {
        log(`shutdown timeout for ${id}: ${err.message}`);
      }
    }

    record.status = "stopped";
  }

  modules.clear();
  loadOrder.length = 0;
  routeRegistry.clear();
  removeLock();
  initialized = false;
  coreModulesRef = null;
  log("all modules shut down");
}

export async function enableModule(moduleId) {
  if (modules.has(moduleId)) return true;

  const discovered = discoverModules();
  const entry = discovered.find((d) => d.manifest.id === moduleId);
  if (!entry) {
    log(`enable failed: module "${moduleId}" not found`);
    return false;
  }

  // Verify dependencies are loaded
  const deps = entry.manifest.dependencies || [];
  for (const dep of deps) {
    if (!modules.has(dep)) {
      log(`enable failed: dependency "${dep}" not loaded`);
      return false;
    }
  }

  let mod;
  try { mod = require(entry.mainFile); }
  catch (err) {
    log(`enable failed: require error for ${moduleId}: ${err.message}`);
    return false;
  }

  const ctx = buildContext(moduleId, entry.manifest);
  moduleConfig.applySchemaDefaults(moduleId, entry.manifest.configSchema);

  const cfg = moduleConfig.get();
  const initTimeout = cfg.system?.initTimeout || INIT_TIMEOUT;

  let api = {};
  if (typeof mod.init === "function") {
    try {
      api = await withTimeout(mod.init(ctx), initTimeout, `${moduleId}.init`) || {};
    } catch (err) {
      log(`enable failed: init error for ${moduleId}: ${err.message}`);
      return false;
    }
  }

  const record = { id: moduleId, manifest: entry.manifest, dir: entry.dir, mod, ctx, api, status: "initialized" };
  modules.set(moduleId, record);
  loadOrder.push(moduleId);

  // Register module MCP tools
  if (entry.manifest.api?.mcp?.length > 0) {
    const moduleToolRegistry = require("./tool-registry");
    const tools = entry.manifest.api.mcp.map(tool => ({
      ...tool,
      name: `zana_${entry.manifest.id}_${tool.name}`,
      moduleId: entry.manifest.id,
    }));
    moduleToolRegistry.registerModuleTools(entry.manifest.id, tools);
  }

  if (typeof mod.ready === "function") {
    try {
      await withTimeout(mod.ready(ctx), initTimeout, `${moduleId}.ready`);
      record.status = "ready";
    } catch (err) {
      log(`ready failed for ${moduleId}: ${err.message}`);
    }
  } else {
    record.status = "ready";
  }

  moduleConfig.setModuleConfig(moduleId, { enabled: true });
  log(`enabled module: ${moduleId}`);
  return true;
}

export async function disableModule(moduleId) {
  const record = modules.get(moduleId);
  if (!record) return false;

  // Check no other loaded module depends on this one
  for (const [id, rec] of modules) {
    if (id === moduleId) continue;
    const deps = rec.manifest.dependencies || [];
    if (deps.includes(moduleId)) {
      log(`disable failed: module "${id}" depends on "${moduleId}"`);
      return false;
    }
  }

  if (typeof record.mod.suspend === "function") {
    try {
      await withTimeout(record.mod.suspend(), SUSPEND_TIMEOUT, `${moduleId}.suspend`);
    } catch (err) {
      log(`suspend timeout for ${moduleId}: ${err.message}`);
    }
  }

  if (typeof record.mod.shutdown === "function") {
    try {
      await withTimeout(record.mod.shutdown(), SHUTDOWN_TIMEOUT, `${moduleId}.shutdown`);
    } catch (err) {
      log(`shutdown timeout for ${moduleId}: ${err.message}`);
    }
  }

  // Unsubscribe any bus listeners held by the module
  if (record.ctx._subscriptions) {
    for (const unsub of record.ctx._subscriptions) {
      try { unsub(); } catch {}
    }
  }

  // Unregister module MCP tools
  const moduleToolRegistry = require("./tool-registry");
  moduleToolRegistry.unregisterModuleTools(moduleId);

  modules.delete(moduleId);
  const idx = loadOrder.indexOf(moduleId);
  if (idx !== -1) loadOrder.splice(idx, 1);

  moduleConfig.setModuleConfig(moduleId, { enabled: false });
  log(`disabled module: ${moduleId}`);
  return true;
}

export function getModule(moduleId) {
  const record = modules.get(moduleId);
  if (!record) return null;
  return {
    id: record.id,
    name: record.manifest.name,
    version: record.manifest.version,
    status: record.status,
    api: record.api,
  };
}

export function listModules() {
  return Array.from(modules.values()).map((r) => ({
    id: r.id,
    name: r.manifest.name,
    version: r.manifest.version,
    status: r.status,
  }));
}

export function handleModuleRoute(pathname, req, res) {
  const match = pathname.match(/^\/m\/([^/]+)\/(.+)$/);
  if (!match) return false;

  const [, moduleId, route] = match;
  const key = `/m/${moduleId}/${route}`;
  const entry = routeRegistry.get(key);
  if (!entry) return false;

  const record = modules.get(moduleId);
  if (!record || record.status === "stopped") return false;

  try {
    entry.handler(req, res, record.ctx);
  } catch (err) {
    log(`route handler error for ${moduleId}/${route}: ${err.message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "module error" }));
  }
  return true;
}

export async function handleRoute(moduleId, routePath, req, res) {
  const route = routePath.replace(/^\//, "");
  const key = `/m/${moduleId}/${route}`;
  const entry = routeRegistry.get(key);
  if (!entry) return false;

  const record = modules.get(moduleId);
  if (!record || record.status === "stopped") return false;

  if (!res.json) {
    res.json = (data, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
  }

  if (!req.query) {
    const url = new URL(req.url, "http://localhost");
    req.query = Object.fromEntries(url.searchParams);
  }

  if (!req.body && (req.method === "POST" || req.method === "PUT")) {
    const MAX_BODY = 1024 * 1024;
    req.body = await new Promise((resolve, reject) => {
      let data = "";
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(); reject(new Error("body too large")); return; }
        data += c;
      });
      req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
      req.on("error", () => resolve({}));
      req.on("close", () => { if (!data) resolve({}); });
    });
  }

  try {
    const result = entry.handler(req, res, record.ctx);
    const resolved = result instanceof Promise ? await result : result;
    if (resolved && typeof resolved === "object" && !res.writableEnded) {
      res.json(resolved);
    }
  } catch (err) {
    log(`route handler error for ${moduleId}/${route}: ${err.message}`);
    if (!res.writableEnded) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "module error" }));
    }
  }
  return true;
}

