import * as crypto from "node:crypto";
import * as eventBusMod from "./bus";
import * as eventBusStore from "./store";

const bus = (eventBusMod as any).bus;

let config = null;
let compactionTimer = null;
let subscribers = [];
let initialized = false;
let getWorkspaceFn = null;

export function init(opts: any = {}) {
  if (initialized) return;
  initialized = true;
  if (opts.getWorkspace) getWorkspaceFn = opts.getWorkspace;

  config = eventBusStore.loadConfig();

  // Monkey-patch bus.emit to capture all events
  const originalEmit = bus.emit.bind(bus);
  bus.emit = function (type, payload) {
    originalEmit(type, payload);
    capture(type, payload);
  };

  // Periodic compaction every 5 min
  compactionTimer = setInterval(() => {
    eventBusStore.compact(config);
  }, 300000);
}

function capture(type, payload) {
  const workspace = getWorkspaceFn ? getWorkspaceFn() : null;
  const event = {
    id: crypto.randomUUID(),
    type,
    source: payload?.agentId || payload?.daemonId || "system",
    timestamp: Date.now(),
    payload: payload || {},
    tags: payload?.tags || [],
    workspace: workspace || undefined,
  };

  if (config?.persistToDisk !== false) {
    eventBusStore.appendEvent(event);
  }

  for (const sub of subscribers) {
    try {
      if (matchesFilter(event, sub.filter)) {
        sub.cb(event);
      }
    } catch (err) {
      console.warn("[event-bus-service] subscriber error:", err.message);
    }
  }
}

function matchesFilter(event, filter) {
  if (!filter) return true;
  if (filter.types && filter.types.length > 0 && !filter.types.includes(event.type)) return false;
  if (filter.source && event.source !== filter.source) return false;
  if (filter.tags && filter.tags.length > 0) {
    if (!event.tags || !filter.tags.some((t) => event.tags.includes(t))) return false;
  }
  return true;
}

export function emit(type, payload, tags) {
  bus.emit(type, { ...payload, tags });
}

export function subscribe(filter, cb) {
  const sub = { filter, cb, id: crypto.randomUUID() };
  subscribers.push(sub);
  return () => {
    subscribers = subscribers.filter((s) => s.id !== sub.id);
  };
}

export function query(filter, limit) {
  return eventBusStore.queryEvents(filter, limit);
}

export function getConfig() {
  return config || eventBusStore.loadConfig();
}

export function setConfig(newConfig) {
  config = { ...config, ...newConfig };
  eventBusStore.saveConfig(config);
}

export function stop() {
  if (compactionTimer) {
    clearInterval(compactionTimer);
    compactionTimer = null;
  }
  subscribers = [];
}

