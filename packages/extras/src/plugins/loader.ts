import * as fs from "node:fs";
import * as path from "node:path";
// Lazy access to @zana/core — avoids load-order issues during core init.
function _core() { return require("@zana/core"); }
function PLUGINS_DIR() { return _core().config.PLUGINS_DIR; }
function ZANA_DIR() { return _core().config.ZANA_DIR; }
function SETTINGS_PATH() { return _core().config.SETTINGS_PATH; }
const eventBusService: any = new Proxy({}, { get: (_t, p) => _core().events.service[p] });

const plugins = new Map();
const disabledSet = new Set();
const errorBudgets = new Map();
const middlewareRegistry = new Map();
const routeRegistry = new Map();
const subscriptions = new Map();

const ERROR_LIMIT = 10;
const ERROR_WINDOW = 60000;
const HANDLER_TIMEOUT = 2000;
const MIDDLEWARE_TIMEOUT = 500;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH(), "utf8")); }
  catch { return {}; }
}

function createPluginLogger(pluginId) {
  return {
    info: (msg) => process.stderr.write(`[plugin:${pluginId}] ${msg}\n`),
    warn: (msg) => process.stderr.write(`[plugin:${pluginId}] WARN ${msg}\n`),
    error: (msg) => process.stderr.write(`[plugin:${pluginId}] ERROR ${msg}\n`),
    debug: (msg) => { if (process.env.ZANA_DEBUG) process.stderr.write(`[plugin:${pluginId}] DEBUG ${msg}\n`); },
  };
}

function createPluginStore(pluginId) {
  const storeFile = path.join(PLUGINS_DIR(), pluginId, "store.json");
  let cache = null;

  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(storeFile, "utf8")); }
    catch { cache = {}; }
    return cache;
  }

  function save() {
    ensureDir(path.dirname(storeFile));
    fs.writeFileSync(storeFile, JSON.stringify(cache, null, 2), "utf8");
  }

  return {
    get(key) { return load()[key]; },
    set(key, value) { load()[key] = value; save(); },
    delete(key) { delete load()[key]; save(); },
    keys() { return Object.keys(load()); },
    clear() { cache = {}; save(); },
  };
}

function createPluginConfig(pluginId) {
  const settings = readSettings();
  return settings.plugins?.[pluginId]?.config || {};
}

function trackError(pluginId) {
  let budget = errorBudgets.get(pluginId);
  if (!budget) {
    budget = { count: 0, windowStart: Date.now() };
    errorBudgets.set(pluginId, budget);
  }
  const now = Date.now();
  if (now - budget.windowStart > ERROR_WINDOW) {
    budget.count = 0;
    budget.windowStart = now;
  }
  budget.count++;
  if (budget.count >= ERROR_LIMIT) {
    disablePlugin(pluginId);
    eventBusService.emit("plugin:disabled", { pluginId, reason: "error budget exceeded" });
  }
}

function withTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    try {
      const result = fn();
      if (result && typeof result.then === "function") {
        result.then((v) => { clearTimeout(timer); resolve(v); })
          .catch((e) => { clearTimeout(timer); reject(e); });
      } else {
        clearTimeout(timer);
        resolve(result);
      }
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

function buildContext(pluginId, pluginDir) {
  const agentManager = _core().agents.manager;
  const ticketService = require("@zana/work").tickets.service;

  return {
    pluginId,
    pluginDir,
    swarm: {
      agents: {
        list: () => agentManager.listAgents(),
        get: (id) => agentManager.listAgents().find((a) => a.id === id) || null,
        spawn: (profile, opts) => agentManager.spawnHeadlessAgent(profile, opts),
        kill: (id) => agentManager.killAgent(id),
      },
      tickets: {
        list: (filter) => ticketService.listTickets(filter),
        get: (id) => ticketService.getTicket(id),
        create: (data) => ticketService.createTicket(data),
        update: (id, data) => ticketService.updateTicket(id, data),
      },
      events: {
        emit: (type, payload, tags) => eventBusService.emit(type, payload, tags),
        query: (filter, limit) => eventBusService.query(filter, limit),
        on: (filter, cb) => eventBusService.subscribe(filter, cb),
      },
      exposeRoute(method, routePath, handler) {
        const key = `${method.toUpperCase()}:/x/${pluginId}/${routePath.replace(/^\//, "")}`;
        routeRegistry.set(key, handler);
      },
      supports(cap) {
        return ["agents", "tickets", "events", "routes"].includes(cap);
      },
    },
    logger: createPluginLogger(pluginId),
    config: createPluginConfig(pluginId),
    store: createPluginStore(pluginId),
  };
}

function subscribeEvents(plugin, mod, ctx) {
  const handlers = mod.on;
  if (!handlers || typeof handlers !== "object") return;
  const subs = [];
  for (const [eventType, handler] of Object.entries(handlers)) {
    if (typeof handler !== "function") continue;
    const filter = eventType === "*" ? {} : { types: [eventType] };
    const unsub = eventBusService.subscribe(filter, (event) => {
      if (disabledSet.has(plugin.id)) return;
      withTimeout(() => handler(event, ctx), HANDLER_TIMEOUT).catch((err) => {
        ctx.logger.error(`event handler "${eventType}" failed: ${err.message}`);
        trackError(plugin.id);
      });
    });
    subs.push(unsub);
  }
  subscriptions.set(plugin.id, subs);
}

function registerMiddleware(plugin, mod) {
  const mw = mod.middleware;
  if (!mw || typeof mw !== "object") return;
  for (const [hookName, handler] of Object.entries(mw)) {
    if (typeof handler !== "function") continue;
    if (!middlewareRegistry.has(hookName)) middlewareRegistry.set(hookName, []);
    middlewareRegistry.get(hookName).push({ pluginId: plugin.id, handler });
  }
}

function registerRoutes(plugin, mod) {
  const contributes = mod.contributes;
  if (!contributes?.routes || !Array.isArray(contributes.routes)) return;
  for (const route of contributes.routes) {
    const method = (route.method || "GET").toUpperCase();
    const routePath = route.path || route.route;
    if (!routePath) continue;
    const handlerName = route.handler;
    const handler = mod.handlers?.[handlerName];
    if (typeof handler !== "function") continue;
    const key = `${method}:/x/${plugin.id}/${routePath.replace(/^\//, "")}`;
    routeRegistry.set(key, handler);
  }
}

export function loadPlugins() {
  const pluginsDir = PLUGINS_DIR();
  ensureDir(pluginsDir);
  let entries;
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(pluginsDir, entry.name);
    const manifestPath = path.join(pluginDir, "plugin.json");
    if (!fs.existsSync(manifestPath)) continue;

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
    catch { continue; }
    if (!manifest.id || !manifest.name || !manifest.version) continue;
    if (plugins.has(manifest.id)) continue;

    const mainFile = path.join(pluginDir, manifest.main || "index.js");
    let mod;
    try { mod = require(mainFile); }
    catch (err) {
      process.stderr.write(`[plugin-loader] failed to require ${manifest.id}: ${err.message}\n`);
      continue;
    }

    const ctx = buildContext(manifest.id, pluginDir);
    const record = { id: manifest.id, name: manifest.name, version: manifest.version, dir: pluginDir, mod, ctx, status: "active" };
    plugins.set(manifest.id, record);

    subscribeEvents(record, mod, ctx);
    registerMiddleware(record, mod);
    registerRoutes(record, mod);

    if (typeof mod.activate === "function") {
      try { mod.activate(ctx); }
      catch (err) {
        ctx.logger.error(`activate failed: ${err.message}`);
        trackError(manifest.id);
      }
    }

    eventBusService.emit("plugin:loaded", { pluginId: manifest.id, name: manifest.name });
  }

  if (plugins.size > 0) {
    process.stderr.write(`[plugin-loader] loaded ${plugins.size} plugin(s)\n`);
  }
}

export function unloadPlugins() {
  for (const [id, record] of plugins) {
    if (typeof record.mod.deactivate === "function") {
      try { record.mod.deactivate(record.ctx); }
      catch {}
    }
    const subs = subscriptions.get(id);
    if (subs) { subs.forEach((unsub) => unsub()); subscriptions.delete(id); }
  }
  plugins.clear();
  middlewareRegistry.clear();
  routeRegistry.clear();
  errorBudgets.clear();
  disabledSet.clear();
}

export function getPlugin(id) {
  const record = plugins.get(id);
  if (!record) return null;
  return { id: record.id, name: record.name, version: record.version, dir: record.dir, status: record.status };
}

export function listPlugins() {
  return Array.from(plugins.values()).map((r) => ({
    id: r.id, name: r.name, version: r.version, dir: r.dir, status: disabledSet.has(r.id) ? "disabled" : r.status,
  }));
}

export function enablePlugin(id) {
  if (!plugins.has(id)) return false;
  disabledSet.delete(id);
  errorBudgets.delete(id);
  plugins.get(id).status = "active";
  eventBusService.emit("plugin:enabled", { pluginId: id });
  return true;
}

export function disablePlugin(id) {
  if (!plugins.has(id)) return false;
  disabledSet.add(id);
  plugins.get(id).status = "disabled";
  return true;
}

export async function runMiddleware(hookName, data) {
  const chain = middlewareRegistry.get(hookName);
  if (!chain || chain.length === 0) return data;
  let current = data;
  for (const { pluginId, handler } of chain) {
    if (disabledSet.has(pluginId)) continue;
    try {
      const result = await withTimeout(() => handler(current, buildContext(pluginId, plugins.get(pluginId)?.dir || "")), MIDDLEWARE_TIMEOUT);
      if (result === null) return null;
      if (result !== undefined) current = result;
    } catch (err) {
      process.stderr.write(`[plugin-loader] middleware "${hookName}" from ${pluginId} failed: ${err.message}\n`);
      trackError(pluginId);
    }
  }
  return current;
}

export function handlePluginRoute(pathname, req, res) {
  const method = req.method.toUpperCase();
  const key = `${method}:${pathname}`;
  const handler = routeRegistry.get(key);
  if (!handler) return false;
  const pluginId = pathname.split("/")[2];
  if (disabledSet.has(pluginId)) return false;
  const ctx = plugins.get(pluginId)?.ctx || buildContext(pluginId, "");
  try { handler(req, res, ctx); }
  catch (err) {
    process.stderr.write(`[plugin-loader] route handler error: ${err.message}\n`);
    trackError(pluginId);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "plugin error" }));
  }
  return true;
}

export const init = loadPlugins;