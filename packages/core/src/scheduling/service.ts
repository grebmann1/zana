import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import * as schedulerStore from "./store";

const timers = new Map();

export function createSchedule(params) {
  const schedule = {
    id: crypto.randomUUID(),
    name: params.name,
    description: params.description || "",
    cron: params.cron || null,
    intervalMs: params.intervalMs || null,
    action: params.action,
    enabled: params.enabled !== false,
    ownerId: params.ownerId || null,
    ownerName: params.ownerName || null,
    lastRunAt: null,
    lastRunResult: null,
    nextRunAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  schedulerStore.saveSchedule(schedule);
  if (schedule.enabled) startTimer(schedule);
  return schedule;
}

export function listSchedules() {
  return schedulerStore.listSchedules();
}

export function getSchedule(id) {
  return schedulerStore.getSchedule(id);
}

export function getRunHistory(id) {
  return schedulerStore.getRunHistory(id);
}

export function updateSchedule(id, fields) {
  const schedule = schedulerStore.getSchedule(id);
  if (!schedule) return { error: "schedule not found" };

  const updated = { ...schedule, ...fields, id, updatedAt: new Date().toISOString() };
  schedulerStore.saveSchedule(updated);

  stopTimer(id);
  if (updated.enabled) startTimer(updated);

  return { ok: true, schedule: updated };
}

export function deleteSchedule(id) {
  stopTimer(id);
  return schedulerStore.deleteSchedule(id);
}

export function enableSchedule(id) {
  const schedule = schedulerStore.getSchedule(id);
  if (!schedule) return { error: "schedule not found" };
  schedule.enabled = true;
  schedule.updatedAt = new Date().toISOString();
  schedulerStore.saveSchedule(schedule);
  startTimer(schedule);
  return { ok: true, schedule };
}

export function disableSchedule(id) {
  const schedule = schedulerStore.getSchedule(id);
  if (!schedule) return { error: "schedule not found" };
  schedule.enabled = false;
  schedule.updatedAt = new Date().toISOString();
  schedulerStore.saveSchedule(schedule);
  stopTimer(id);
  return { ok: true, schedule };
}

async function executeAction(action) {
  const type = action.type;

  if (type === "prompt") {
    const agentManager = require("../agents/manager");
    const profileStore = require("../agents/profile-store");
    const profile = profileStore.getProfile(action.profileId);
    if (!profile) {
      return { status: "error", error: `profile not found: ${action.profileId}` };
    }
    const { agentId } = agentManager.spawnHeadlessAgent(profile, {
      prompt: action.prompt,
      cwd: action.cwd || process.env.HOME,
    });
    return { status: "success", agentId };
  }

  if (type === "team") {
    const teamManager = require("../teams/manager");
    const result = teamManager.startTeam(action.teamId, { prompt: action.prompt });
    if (!result.ok) {
      return { status: "error", error: result.error };
    }
    return { status: "success", orchestratorAgentId: result.orchestratorAgentId };
  }

  if (type === "command") {
    return new Promise((resolve) => {
      execFile("/bin/sh", ["-c", action.command], { cwd: action.cwd || process.env.HOME }, (err, stdout, stderr) => {
        if (err) {
          resolve({ status: "error", error: err.message, exitCode: err.code, stdout, stderr });
        } else {
          resolve({ status: "success", stdout, stderr });
        }
      });
    });
  }

  if (type === "mcp_tool") {
    return { status: "skipped", error: "mcp_tool execution not implemented" };
  }

  return { status: "error", error: `unknown action type: ${type}` };
}

export async function triggerSchedule(id) {
  const schedule = schedulerStore.getSchedule(id);
  if (!schedule) return { error: "schedule not found" };

  const startedAt = new Date().toISOString();
  let actionResult;

  try {
    actionResult = await executeAction(schedule.action);
  } catch (err) {
    actionResult = { status: "error", error: err.message || String(err) };
  }

  const finishedAt = new Date().toISOString();
  const result = {
    status: actionResult.status,
    startedAt,
    finishedAt,
    actionType: schedule.action.type,
    ...actionResult,
  };

  schedule.lastRunAt = startedAt;
  schedule.lastRunResult = actionResult.status === "success" ? "success" : `error: ${actionResult.error}`;
  schedule.updatedAt = new Date().toISOString();
  schedulerStore.saveSchedule(schedule);
  schedulerStore.appendRunResult(id, result);

  return { ok: true, schedule, result };
}

function startTimer(schedule) {
  if (!schedule.intervalMs) return;
  stopTimer(schedule.id);
  const timer = setInterval(() => {
    triggerSchedule(schedule.id).catch((err) => {
      console.error(`[scheduler] timer trigger failed for ${schedule.id}:`, err.message || err);
    });
  }, schedule.intervalMs);
  timer.unref();
  timers.set(schedule.id, timer);
}

function stopTimer(id) {
  const timer = timers.get(id);
  if (timer) {
    clearInterval(timer);
    timers.delete(id);
  }
}

export function stopAll() {
  for (const [id] of timers) {
    stopTimer(id);
  }
}

