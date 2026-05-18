import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import * as schedulerStore from "./store";
import { pickBackend, computeNextRunAt } from "./triggers";
import { everShorthandToMs } from "./yaml-format";

interface ActiveTrigger {
  scheduleId: string;
  kind: "cron" | "interval";
  handle: any;
  stop: (handle: any) => void;
}

const triggers = new Map<string, ActiveTrigger>();

// agentId → scheduleId, for spawn-agent schedule fires whose result summary
// hasn't been inlined yet. The schedule history entry is appended at fire
// time with the agentId; once the agent terminates we patch the same entry
// with the result summary, tokens, cost, etc.
const inflightAgents = new Map<string, { scheduleId: string }>();
let busSubscribed = false;

function ensureAgentTerminationListener() {
  if (busSubscribed) return;
  let bus: any, EVENTS: any;
  try {
    const core = require("@zana/core");
    bus = core.events?.bus ?? require("@zana/core/src/events/bus").bus;
    EVENTS = core.events?.EVENTS ?? require("@zana/core/src/events/bus").EVENTS;
  } catch (err: any) {
    // @zana/core isn't loaded yet — try again next time someone calls
    // executeAction. This keeps the cycle break clean.
    return;
  }
  if (!bus || !EVENTS?.AGENT_TERMINATED) return;

  bus.on(EVENTS.AGENT_TERMINATED, (evt: any) => {
    const tracked = inflightAgents.get(evt.agentId);
    if (!tracked) return;
    inflightAgents.delete(evt.agentId);
    try {
      const agentManager = require("@zana/core").agents.manager;
      const agent = agentManager.getAgent(evt.agentId);
      const resultText: string =
        (agent?.result as string) ||
        (typeof evt.output === "string" ? evt.output : "") ||
        "";
      const finalStatus =
        agent?.state === "terminated" || evt.reason === "completed"
          ? "success"
          : "error";
      schedulerStore.updateRunResult(tracked.scheduleId, evt.agentId, {
        summary: resultText.slice(0, 500),
        tokensIn: agent?.tokensIn ?? null,
        tokensOut: agent?.tokensOut ?? null,
        costUsd: agent?.costUsd ?? null,
        durationMs: agent?.durationMs ?? null,
        finalStatus,
      });
    } catch (err: any) {
      console.warn(
        `[scheduler] failed to inline agent result for schedule ${tracked.scheduleId} agent ${evt.agentId}: ${err?.message || err}`
      );
    }
  });
  busSubscribed = true;
}

/** Normalize legacy flat fields into the nested schedule.{cron,intervalMs,every} block. */
function normalizeSchedule(raw: any) {
  const s = { ...raw };
  if (!s.schedule || typeof s.schedule !== "object") s.schedule = {};
  if (s.cron && !s.schedule.cron) s.schedule.cron = s.cron;
  if (s.intervalMs != null && s.schedule.intervalMs == null) s.schedule.intervalMs = s.intervalMs;
  if (s.every && !s.schedule.every) s.schedule.every = s.every;
  // If `every` is set, project it to intervalMs for runtime convenience.
  if (s.schedule.every && s.schedule.intervalMs == null) {
    try {
      s.schedule.intervalMs = everShorthandToMs(s.schedule.every);
    } catch {
      // keep as-is; pickBackend will return null
    }
  }
  return s;
}

export function createSchedule(params) {
  const cronExpr = params.cron || params.schedule?.cron || null;
  let intervalMs = params.intervalMs ?? params.schedule?.intervalMs ?? null;
  const every = params.every || params.schedule?.every || null;
  if (intervalMs == null && typeof every === "string") {
    try {
      intervalMs = everShorthandToMs(every);
    } catch {
      // leave null
    }
  }

  const schedule: any = {
    id: params.id || crypto.randomUUID(),
    name: params.name,
    description: params.description || "",
    enabled: params.enabled !== false,
    schedule: {
      ...(cronExpr ? { cron: cronExpr } : {}),
      ...(every ? { every } : {}),
      ...(intervalMs != null ? { intervalMs } : {}),
    },
    action: params.action,
    ownerId: params.ownerId || null,
    ownerName: params.ownerName || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: {
      lastRunAt: null,
      lastRunResult: null,
      nextRunAt: null,
      runCount: 0,
    },
  };

  // Default new schedules to YAML.
  schedulerStore.saveScheduleYaml(schedule);
  if (schedule.enabled) startTrigger(schedule);
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
  // Preserve the original on-disk format.
  schedulerStore.saveScheduleSameFormat(updated);

  stopTrigger(id);
  if (updated.enabled) startTrigger(updated);

  return { ok: true, schedule: updated };
}

export function deleteSchedule(id) {
  stopTrigger(id);
  return schedulerStore.deleteSchedule(id);
}

export function enableSchedule(id) {
  const schedule = schedulerStore.getSchedule(id);
  if (!schedule) return { error: "schedule not found" };
  schedule.enabled = true;
  schedule.updatedAt = new Date().toISOString();
  schedulerStore.saveScheduleSameFormat(schedule);
  startTrigger(schedule);
  return { ok: true, schedule };
}

export function disableSchedule(id) {
  const schedule = schedulerStore.getSchedule(id);
  if (!schedule) return { error: "schedule not found" };
  schedule.enabled = false;
  schedule.updatedAt = new Date().toISOString();
  schedulerStore.saveScheduleSameFormat(schedule);
  stopTrigger(id);
  return { ok: true, schedule };
}

async function executeAction(action) {
  const type = action?.type;

  if (type === "prompt" || type === "spawn-agent") {
    const agentManager = require("@zana/core").agents.manager;
    const profileStore = require("@zana/core").agents.profileStore;
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

  if (type === "workflow") {
    return { status: "skipped", error: "workflow action type not yet wired" };
  }

  if (type === "command") {
    // Two safe forms accepted:
    //   action.command: ["binary", "arg1", "arg2"]  → execFile binary directly
    //   action.argv:    ["binary", "arg1", "arg2"]  → alias of the above
    // Legacy string form is rejected: it required /bin/sh -c which is a
    // shell-injection vector for any user-supplied schedule.
    let argv: string[] | null = null;
    if (Array.isArray(action.command)) argv = action.command;
    else if (Array.isArray(action.argv)) argv = action.argv;

    if (!argv || argv.length === 0 || typeof argv[0] !== "string") {
      return {
        status: "error",
        error:
          "command action requires `command` or `argv` as a non-empty array of strings (e.g. command: [\"npm\", \"run\", \"build\"]). Shell strings are rejected as a security measure.",
      };
    }

    const [bin, ...args] = argv;
    return new Promise((resolve) => {
      execFile(
        bin,
        args,
        { cwd: action.cwd || process.env.HOME, shell: false },
        (err: any, stdout, stderr) => {
          if (err) {
            resolve({ status: "error", error: err.message, exitCode: err.code, stdout, stderr });
          } else {
            resolve({ status: "success", stdout, stderr });
          }
        }
      );
    });
  }

  if (type === "mcp_tool") {
    return { status: "skipped", error: "mcp_tool execution not implemented" };
  }

  return { status: "error", error: `unknown action type: ${type}` };
}

export async function triggerSchedule(id) {
  const raw = schedulerStore.getSchedule(id);
  if (!raw) return { error: "schedule not found" };
  const schedule = normalizeSchedule(raw);

  // Make sure we're subscribed to agent terminations before any spawn races.
  ensureAgentTerminationListener();

  const startedAt = new Date().toISOString();
  let actionResult: any;

  try {
    actionResult = await executeAction(schedule.action);
  } catch (err: any) {
    actionResult = { status: "error", error: err?.message || String(err) };
  }

  const finishedAt = new Date().toISOString();
  const result: any = {
    status: actionResult.status,
    startedAt,
    finishedAt,
    actionType: schedule.action?.type,
    ...actionResult,
  };

  // For spawn-agent fires, track the agentId so the agent-terminated
  // handler can patch this history entry with the result summary later.
  if (
    (schedule.action?.type === "spawn-agent" || schedule.action?.type === "prompt") &&
    typeof actionResult?.agentId === "string"
  ) {
    inflightAgents.set(actionResult.agentId, { scheduleId: id });
    if (result.finalStatus === undefined) result.finalStatus = "pending";
    if (result.summary === undefined) result.summary = "";
  }

  // Update status block (preferred), keeping legacy flat fields in sync
  // for any consumer still reading them.
  const status = (schedule.status && typeof schedule.status === "object") ? { ...schedule.status } : {};
  status.lastRunAt = startedAt;
  status.lastRunResult = actionResult.status === "success" ? "success" : `error: ${actionResult.error}`;
  status.runCount = (typeof status.runCount === "number" ? status.runCount : 0) + 1;
  status.nextRunAt = computeNextRunAt(schedule, new Date(finishedAt));

  schedule.status = status;
  schedule.lastRunAt = status.lastRunAt;
  schedule.lastRunResult = status.lastRunResult;
  schedule.nextRunAt = status.nextRunAt;
  schedule.updatedAt = new Date().toISOString();

  schedulerStore.saveScheduleSameFormat(schedule);
  schedulerStore.appendRunResult(id, result);

  return { ok: true, schedule, result };
}

function startTrigger(rawSchedule: any) {
  const schedule = normalizeSchedule(rawSchedule);
  if (!schedule.enabled) return;
  stopTrigger(schedule.id);

  const picked = pickBackend(schedule);
  if (!picked) {
    console.warn(`[scheduler] no backend matched for schedule ${schedule.id} — skipping start`);
    return;
  }

  let handle: any;
  try {
    handle = picked.start(schedule.id, picked.arg, () => {
      triggerSchedule(schedule.id).catch((err: any) => {
        console.error(`[scheduler] trigger fire failed for ${schedule.id}:`, err?.message || err);
      });
    });
  } catch (err: any) {
    console.error(`[scheduler] failed to start trigger for ${schedule.id}:`, err?.message || err);
    return;
  }

  triggers.set(schedule.id, {
    scheduleId: schedule.id,
    kind: picked.kind,
    handle,
    stop: picked.stop,
  });

  // Persist nextRunAt on start so `zana schedule list` is accurate.
  const next = computeNextRunAt(schedule);
  if (next) {
    const updated = { ...schedule };
    updated.status = { ...(schedule.status || {}), nextRunAt: next };
    updated.nextRunAt = next;
    try {
      schedulerStore.saveScheduleSameFormat(updated);
    } catch {
      // best-effort
    }
  }
}

function stopTrigger(id: string) {
  const entry = triggers.get(id);
  if (entry) {
    try {
      entry.stop(entry.handle);
    } catch {
      // ignore
    }
    triggers.delete(id);
  }
}

export function stopAll() {
  for (const id of Array.from(triggers.keys())) stopTrigger(id);
}

/**
 * Read every schedule from disk and start triggers for the enabled ones.
 * Idempotent — re-running stops then restarts triggers.
 */
export function loadFromDisk() {
  let started = 0;
  let skipped = 0;
  const all = schedulerStore.listSchedules();
  for (const s of all) {
    if (!s || !s.id) {
      skipped++;
      continue;
    }
    if (!s.enabled) {
      skipped++;
      continue;
    }
    try {
      startTrigger(s);
      started++;
    } catch (err: any) {
      console.warn(`[scheduler] loadFromDisk: failed to start ${s.id}:`, err?.message || err);
      skipped++;
    }
  }
  console.log(`[scheduler] loadFromDisk: started=${started} skipped=${skipped} total=${all.length}`);
  return { started, skipped, total: all.length };
}

/** Test-only helper: snapshot the active triggers map. */
export function _getActiveTriggers() {
  return Array.from(triggers.values()).map((t) => ({
    scheduleId: t.scheduleId,
    kind: t.kind,
  }));
}
