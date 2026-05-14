import { bus } from "./event-bus";

export const STALE_AGENT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
export const MEMORY_THRESHOLD_MB = 512;
const CHECK_INTERVAL_MS = 60_000;

let interval = null;
let getAgents = null;

export function init(agentListFn) {
  getAgents = agentListFn;
  interval = setInterval(check, CHECK_INTERVAL_MS);
  if (interval.unref) interval.unref();
}

export function check() {
  if (!getAgents) return;
  checkStaleAgents();
  checkMemory();
}

function checkStaleAgents() {
  const agents = getAgents();
  const now = Date.now();
  for (const agent of agents) {
    if (agent.state === "terminated") continue;
    const lastActivity = agent.lastActivityAt || agent.spawnedAt;
    if (!lastActivity) continue;
    const age = now - new Date(lastActivity).getTime();
    if (age > STALE_AGENT_THRESHOLD_MS) {
      bus.emit("health:stale-agent", {
        agentId: agent.id,
        profileName: agent.profileName,
        inactiveMinutes: Math.round(age / 60000),
      });
    }
  }
}

function checkMemory() {
  const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  if (heapMB > MEMORY_THRESHOLD_MB) {
    bus.emit("health:memory-warning", { heapMB, threshold: MEMORY_THRESHOLD_MB });
  }
}

export function getStatus(agentListFn) {
  const agents = (agentListFn || getAgents || (() => []))();
  const active = agents.filter((a) => a.state !== "terminated");
  const mem = process.memoryUsage();
  return {
    status: "ok",
    uptime: process.uptime(),
    memory: {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      rss: Math.round(mem.rss / 1024 / 1024),
    },
    agents: {
      total: agents.length,
      active: active.length,
    },
    pid: process.pid,
    nodeVersion: process.version,
  };
}

export function stop() {
  if (interval) { clearInterval(interval); interval = null; }
}

