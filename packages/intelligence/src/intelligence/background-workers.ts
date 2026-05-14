/**
 * background-workers.js — Proactive workers that auto-trigger based on
 * conditions (file changes, schedules, event patterns) without user intervention.
 */
import * as fs from "node:fs";
import * as path from "node:path";
function _core() { return require("@zana/core"); }
function ZANA_DIR() { return _core().config.ZANA_DIR; }
function _eventBus(): any { return _core().events.service; }
function _agentManager(): any { return _core().agents.manager; }
function _workspaceContext(): any { return _core().project.workspaceContext; }
function _profileStore(): any { return _core().agents.profileStore; }

function WORKERS_PATH() { return path.join(ZANA_DIR(), "workers.json"); }
const MAX_GLOBAL_CONCURRENT = 3;
const MAX_HISTORY = 50;
const CRON_INTERVAL = 60000;
const RETRY_DELAY = 60000;

let workers = new Map();
let runHistory = new Map();
let runningInstances = new Map();
let timers = new Map();
let unsubscribers = new Map();
let fileWatchers = new Map();
let cronTimer = null, retryTimer = null, retryQueue = [], initialized = false;

const BUILTIN_WORKERS = [{
  id: "audit", name: "Security Auditor", profileId: "code-reviewer",
  trigger: { type: "schedule", interval: 7200000 },
  promptTemplate: "Review the codebase for security issues: SQL injection, XSS, command injection, exposed secrets. Report findings as a list.",
  enabled: false, maxConcurrent: 1,
}, {
  id: "testgaps", name: "Test Gap Detector", profileId: "test-writer",
  trigger: { type: "event", filter: { types: ["ticket:completed"] } },
  promptTemplate: "Analyze recent code changes and identify functions/modules without test coverage. Create a report.",
  enabled: false, maxConcurrent: 1,
}, {
  id: "optimize", name: "Refactor Advisor", profileId: "architect",
  trigger: { type: "schedule", interval: 86400000 },
  promptTemplate: "Review the codebase for code duplication, overly complex functions, and performance issues. Suggest specific refactors.",
  enabled: false, maxConcurrent: 1,
}];

// Cron parsing — supports */N, N, and * for minute/hour/dom/month/dow
function matchesCronField(field, value) {
  if (field === "*") return true;
  if (field.startsWith("*/")) { const s = parseInt(field.slice(2), 10); return s > 0 && value % s === 0; }
  return parseInt(field, 10) === value;
}
function matchesCron(expr) {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return false;
  const n = new Date();
  return matchesCronField(p[0], n.getMinutes()) && matchesCronField(p[1], n.getHours()) &&
    matchesCronField(p[2], n.getDate()) && matchesCronField(p[3], n.getMonth() + 1) &&
    matchesCronField(p[4], n.getDay());
}

// Persistence
function loadConfig() {
  try {
    if (fs.existsSync(WORKERS_PATH())) {
      const d = JSON.parse(fs.readFileSync(WORKERS_PATH(), "utf8"));
      return Array.isArray(d) ? d : [];
    }
  } catch (e) { console.warn("[background-workers] load error:", e.message); }
  return [];
}
function saveConfig() {
  try {
    const workersPath = WORKERS_PATH();
    const dir = path.dirname(workersPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = Array.from(workers.values()).map((w) => ({
      id: w.id, name: w.name, profileId: w.profileId, trigger: w.trigger,
      promptTemplate: w.promptTemplate, enabled: w.enabled, maxConcurrent: w.maxConcurrent,
    }));
    fs.writeFileSync(workersPath, JSON.stringify(data, null, 2));
  } catch (e) { console.warn("[background-workers] save error:", e.message); }
}

// Concurrency
function globalRunning() {
  let t = 0; for (const s of runningInstances.values()) t += s.size; return t;
}
function canRun(id) {
  const w = workers.get(id);
  if (!w || !w.enabled) return false;
  const inst = runningInstances.get(id) || new Set();
  return inst.size < (w.maxConcurrent || 1) && globalRunning() < MAX_GLOBAL_CONCURRENT;
}

// Execution
async function executeWorker(workerId) {
  const worker = workers.get(workerId);
  if (!worker) return { agentId: null, status: "not_found" };
  if (!canRun(workerId)) {
    if (!retryQueue.find((q) => q.workerId === workerId)) retryQueue.push({ workerId, queuedAt: Date.now() });
    return { agentId: null, status: "queued" };
  }
  const startTime = Date.now();
  const wsCtx = _workspaceContext();
  const workspace = wsCtx.isInitialized() ? wsCtx.getWorkspaceRoot() : process.env.HOME;
  const profile = _profileStore().getProfile(worker.profileId);
  if (!profile) return { agentId: null, status: "profile_not_found" };

  let agentId = null;
  try {
    if (!runningInstances.has(workerId)) runningInstances.set(workerId, new Set());
    const result = _agentManager().spawnHeadlessAgent(profile, { prompt: worker.promptTemplate, cwd: workspace });
    agentId = result.agentId;
    runningInstances.get(workerId).add(agentId);
    worker.lastRun = Date.now();
    const eventBus = _eventBus();
    eventBus.emit("worker:triggered", { workerId, agentId });

    const unsub = eventBus.subscribe({ types: ["agent:terminated", "agent:completed", "agent:failed"] }, (ev) => {
      if (ev.payload?.agentId !== agentId) return;
      unsub();
      const duration = Date.now() - startTime;
      const success = ev.type !== "agent:failed";
      runningInstances.get(workerId)?.delete(agentId);
      addHistory(workerId, { timestamp: startTime, agentId, success, duration });
      eventBus.emit(success ? "worker:completed" : "worker:failed", { workerId, agentId, duration });
    });
    return { agentId, status: "triggered" };
  } catch (err) {
    if (agentId) runningInstances.get(workerId)?.delete(agentId);
    addHistory(workerId, { timestamp: startTime, agentId, success: false, duration: Date.now() - startTime });
    _eventBus().emit("worker:failed", { workerId, agentId, error: err.message });
    return { agentId, status: "error" };
  }
}
function addHistory(workerId, entry) {
  if (!runHistory.has(workerId)) runHistory.set(workerId, []);
  const h = runHistory.get(workerId);
  h.unshift(entry);
  if (h.length > MAX_HISTORY) h.length = MAX_HISTORY;
}

// Trigger management
function teardownTrigger(id) {
  if (timers.has(id)) { clearInterval(timers.get(id)); timers.delete(id); }
  if (unsubscribers.has(id)) { unsubscribers.get(id)(); unsubscribers.delete(id); }
  if (fileWatchers.has(id)) { fileWatchers.get(id).close(); fileWatchers.delete(id); }
}
function matchesFilePattern(filename, patterns) {
  for (const p of patterns) {
    const ext = p.replace(/^\*\*\/?\*/, "");
    if (ext && filename.endsWith(ext)) return true;
    if (p === "*" || p === "**/*") return true;
  }
  return false;
}
function setupTrigger(worker) {
  teardownTrigger(worker.id);
  if (!worker.enabled) return;
  const { trigger } = worker;
  if (trigger.type === "schedule" && trigger.interval > 0) {
    timers.set(worker.id, setInterval(() => executeWorker(worker.id), trigger.interval));
  } else if (trigger.type === "event" && trigger.filter) {
    unsubscribers.set(worker.id, _eventBus().subscribe(trigger.filter, () => executeWorker(worker.id)));
  } else if (trigger.type === "filewatch" && trigger.patterns) {
    try {
      const wsCtx = _workspaceContext();
      const ws = wsCtx.isInitialized() ? wsCtx.getWorkspaceRoot() : null;
      if (ws) {
        const watcher = fs.watch(ws, { recursive: true }, (_, fn) => {
          if (fn && matchesFilePattern(fn, trigger.patterns)) executeWorker(worker.id);
        });
        fileWatchers.set(worker.id, watcher);
      }
    } catch (e) { console.warn("[background-workers] filewatch error:", e.message); }
  }
}

// Background loops
function startCronLoop() {
  if (cronTimer) return;
  cronTimer = setInterval(() => {
    for (const w of workers.values()) {
      if (w.enabled && w.trigger.type === "cron" && w.trigger.expression) {
        if (matchesCron(w.trigger.expression)) executeWorker(w.id);
      }
    }
  }, CRON_INTERVAL);
}
function startRetryLoop() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    const pending = retryQueue.splice(0);
    for (const item of pending) {
      if (canRun(item.workerId)) executeWorker(item.workerId);
      else retryQueue.push(item);
    }
  }, RETRY_DELAY);
}

// Public API
export function init() {
  if (initialized) return;
  initialized = true;
  const saved = loadConfig();
  const savedMap = new Map(saved.map((w) => [w.id, w]));
  for (const b of BUILTIN_WORKERS) {
    const merged = savedMap.has(b.id) ? { ...b, ...savedMap.get(b.id) } : { ...b };
    workers.set(merged.id, merged);
    savedMap.delete(b.id);
  }
  for (const c of savedMap.values()) workers.set(c.id, c);
  for (const w of workers.values()) setupTrigger(w);
  startCronLoop();
  startRetryLoop();
}

export function list() {
  return Array.from(workers.values()).map((w) => {
    let nextRun = null;
    if (w.enabled && w.trigger.type === "schedule" && w.trigger.interval) {
      nextRun = (w.lastRun || Date.now()) + w.trigger.interval;
    }
    return { id: w.id, name: w.name, enabled: w.enabled, trigger: w.trigger,
      lastRun: w.lastRun || null, nextRun, running: (runningInstances.get(w.id)?.size || 0) > 0 };
  });
}

export function enable(workerId) {
  const w = workers.get(workerId);
  if (!w) return false;
  w.enabled = true; setupTrigger(w); saveConfig(); return true;
}
export function disable(workerId) {
  const w = workers.get(workerId);
  if (!w) return false;
  w.enabled = false; teardownTrigger(workerId); saveConfig(); return true;
}
export async function trigger(workerId) { return executeWorker(workerId); }

export function register(def) {
  if (!def || !def.id) throw new Error("Worker definition must have an id");
  const worker = {
    id: def.id, name: def.name || def.id, profileId: def.profileId,
    trigger: def.trigger || { type: "schedule", interval: 3600000 },
    promptTemplate: def.promptTemplate || "", enabled: def.enabled ?? false,
    maxConcurrent: def.maxConcurrent || 1,
  };
  workers.set(worker.id, worker);
  setupTrigger(worker); saveConfig();
  _eventBus().emit("worker:registered", { workerId: worker.id, name: worker.name });
}
export function unregister(workerId) {
  if (!workers.has(workerId)) return false;
  teardownTrigger(workerId);
  workers.delete(workerId); runHistory.delete(workerId); runningInstances.delete(workerId);
  saveConfig(); return true;
}
export function history(workerId, limit = 10) {
  return (runHistory.get(workerId) || []).slice(0, limit);
}
export function shutdown() {
  for (const id of workers.keys()) teardownTrigger(id);
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null; }
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  retryQueue = []; initialized = false;
}

