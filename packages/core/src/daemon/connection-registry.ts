import * as crypto from "node:crypto";
import { bus } from "@zana-ai/contracts";

const connections = new Map();

export function register(type, meta = {}) {
  const id = crypto.randomUUID().slice(0, 12);
  const conn = {
    id,
    type,
    connectedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    ...meta,
  };
  connections.set(id, conn);
  bus.emit("connection:opened", { connectionId: id, type });
  return id;
}

export function unregister(id) {
  const conn = connections.get(id);
  if (conn) {
    connections.delete(id);
    bus.emit("connection:closed", { connectionId: id, type: conn.type });
  }
}

export function touch(id) {
  const conn = connections.get(id);
  if (conn) {
    conn.lastActivity = new Date().toISOString();
  }
}

export function list() {
  return Array.from(connections.values());
}

export function getCount() {
  return connections.size;
}

export function getByType(type) {
  return Array.from(connections.values()).filter((c) => c.type === type);
}

const STALE_MS = 5 * 60 * 1000;

export function cleanStale() {
  const now = Date.now();
  let removed = 0;
  for (const [id, conn] of connections) {
    const age = now - new Date(conn.lastActivity).getTime();
    if (age > STALE_MS) {
      connections.delete(id);
      removed++;
    }
  }
  return removed;
}

