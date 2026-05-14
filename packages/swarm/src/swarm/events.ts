// Hive Mind Events — ring buffer for sub-hive → master event reporting.

import * as crypto from "node:crypto";

const MAX_EVENTS = 1000;
const events = [];

let changeListeners = [];

export function addEvent(event) {
  if (!event.id) event.id = crypto.randomUUID();
  if (!event.timestamp) event.timestamp = Date.now();

  events.push(event);

  // Ring buffer: drop oldest when full
  if (events.length > MAX_EVENTS) {
    events.shift();
  }

  for (const cb of changeListeners) {
    try { cb(event); } catch (err) {
      console.warn("[swarm-events] listener callback error:", err.message || err);
    }
  }
}

export function query({ since, hiveId, type, limit } = {}) {
  let result = events;

  if (since) {
    result = result.filter((e) => e.timestamp > since);
  }
  if (hiveId) {
    result = result.filter((e) => e.hiveId === hiveId);
  }
  if (type) {
    result = result.filter((e) => e.type === type);
  }
  if (limit) {
    result = result.slice(-limit);
  }

  return result;
}

export function pending(since) {
  if (!since) return [...events];
  return events.filter((e) => e.timestamp > since);
}

export function clear() {
  events.length = 0;
}

export function onChange(cb) {
  changeListeners.push(cb);
  return () => {
    changeListeners = changeListeners.filter((l) => l !== cb);
  };
}

