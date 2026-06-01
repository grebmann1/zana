import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import * as schedulerStore from "./store";
import { pickBackend, computeNextRunAt } from "./triggers";
import { everShorthandToMs } from "./yaml-format";
import { validateSchedule, ValidationIssue } from "./schema";

function _log() { return require("@zana-ai/core").util.logger.getLogger("scheduler"); }

function logWarnings(scheduleId: string, issues: ValidationIssue[]) {
  for (const w of issues) {
    if (w.level === "warning") {
      _log().warn(`${scheduleId}: ${w.field}: ${w.message}`);
    }
  }
}

function firstError(issues: ValidationIssue[]): string | null {
  const e = issues.find((i) => i.level === "error");
  return e ? `${e.field}: ${e.message}` : null;
}

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
//
// Each entry carries `spawnedAt` so a periodic sweep can prune stale entries
// (hung/SIGKILL'd agents whose AGENT_TERMINATED event never fires). Without
// the TTL sweep the Map grew linearly with daemon uptime + agent failures.
const inflightAgents = new Map<string, { scheduleId: string; spawnedAt: number }>();
// Slightly longer than the default agentTimeoutMinutes (4 min) so we don't
// prune entries that are still legitimately in flight for a normal-length run.
const INFLIGHT_TTL_MS = 6 * 60 * 1000;
let busSubscribed = false;

/** Remove inflightAgents entries older than INFLIGHT_TTL_MS. Returns count pruned. */
export function sweepInflightAgents(): number {
  const now = Date.now();
  let pruned = 0;
  for (const [agentId, info] of inflightAgents) {
    if (now - info.spawnedAt > INFLIGHT_TTL_MS) {
      inflightAgents.delete(agentId);
      pruned++;
    }
  }
  return pruned;
}

/** Test-only: snapshot the inflight tracking map. */
export function _getInflightAgentsForTest() {
  return Array.from(inflightAgents.entries()).map(([agentId, info]) => ({
    agentId,
    scheduleId: info.scheduleId,
    spawnedAt: info.spawnedAt,
  }));
}

/** Test-only: insert an inflight tracking entry directly (bypasses spawn). */
export function _trackAgentForTest(agentId: string, scheduleId: string, spawnedAt?: number) {
  inflightAgents.set(agentId, {
    scheduleId,
    spawnedAt: typeof spawnedAt === "number" ? spawnedAt : Date.now(),
  });
}

function attachTerminationListener(bus: any, eventName: string) {
  bus.on(eventName, (evt: any) => {
    // Opportunistic sweep: every real termination is a chance to prune stale
    // entries (hung/SIGKILL'd peers whose own event never fired).
    sweepInflightAgents();
    const tracked = inflightAgents.get(evt.agentId);
    if (!tracked) return;
    inflightAgents.delete(evt.agentId);
    try {
      const agentManager = require("@zana-ai/core").agents.manager;
      const agent = agentManager.getAgent(evt.agentId);
      const resultText: string =
        (agent?.result as string) ||
        (typeof evt.output === "string" ? evt.output : "") ||
        "";
      // Use exitCode as source of truth: agent.state === "terminated" is set
      // for BOTH clean exits and killed/crashed agents (SIGKILL, timeout, OOM),
      // so it can't distinguish success from failure. The agent record now
      // persists exitCode in .zana/runs/<id>.json, and the bus event also
      // carries evt.exitCode. exitCode === 0 ⇒ success; anything else (or
      // missing) ⇒ error (conservative — better to flag a real success as
      // error than to silently record a killed agent as a success).
      const exitCode =
        typeof evt.exitCode === "number" ? evt.exitCode : agent?.exitCode;
      const finalStatus = exitCode === 0 ? "success" : "error";
      schedulerStore.updateRunResult(tracked.scheduleId, evt.agentId, {
        summary: resultText.slice(0, 500),
        tokensIn: agent?.tokensIn ?? null,
        tokensOut: agent?.tokensOut ?? null,
        costUsd: agent?.costUsd ?? null,
        durationMs: agent?.durationMs ?? null,
        finalStatus,
      });
    } catch (err: any) {
      _log().warn(
        `failed to inline agent result for schedule ${tracked.scheduleId} agent ${evt.agentId}`,
        err
      );
    }
  });
}

function ensureAgentTerminationListener() {
  if (busSubscribed) return;
  let bus: any, EVENTS: any;
  try {
    const events = require("@zana-ai/core").events;
    bus = events?.bus;
    EVENTS = events?.EVENTS;
  } catch {
    // @zana-ai/core isn't loaded yet — retry on next executeAction call.
    return;
  }
  if (!bus || !EVENTS?.AGENT_TERMINATED) return;
  attachTerminationListener(bus, EVENTS.AGENT_TERMINATED);
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
    ...(params.history ? { history: params.history } : {}),
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

  const issues = validateSchedule(schedule);
  const err = firstError(issues);
  if (err) return { error: `invalid schedule: ${err}` };
  logWarnings(schedule.id, issues);

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

  const issues = validateSchedule(updated);
  const err = firstError(issues);
  if (err) return { error: `invalid schedule: ${err}` };
  logWarnings(id, issues);

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
    const agentManager = require("@zana-ai/core").agents.manager;
    const profileStore = require("@zana-ai/core").agents.profileStore;
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
    if (!action.skillId || typeof action.skillId !== "string") {
      return { status: "error", error: "workflow action requires skillId (string)" };
    }
    const skillStore = require("@zana-ai/extras").settings.skillStore;
    const skill = skillStore.getSkill(action.skillId);
    if (!skill) return { status: "error", error: `workflow skill not found: ${action.skillId}` };
    if (skill.type !== "workflow") {
      return { status: "error", error: `skill is not a workflow (type=${skill.type}): ${action.skillId}` };
    }
    const workflowEngine = require("@zana-ai/work").scheduling.workflowEngine;
    const triggerContext = { trigger: "scheduler", ...(action.context || {}) };
    const run = await workflowEngine.executeWorkflow(skill, triggerContext);
    if (run?.error) {
      return { status: "error", error: run.error, runId: run.id };
    }
    if (run?.status === "completed") {
      return { status: "success", runId: run.id, steps: run.steps?.length };
    }
    if (run?.status === "halted") {
      return { status: "halted", runId: run.id, currentStep: run.currentStep };
    }
    return { status: "error", error: `workflow ended with status: ${run?.status}`, runId: run?.id };
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
    // Most MCP tools (zana_X) map 1:1 to orchestrator actions (X).
    // We strip the zana_ prefix and dispatch through the orchestrator —
    // same path the stdio MCP server uses, but without the framing.
    if (!action.toolName || typeof action.toolName !== "string") {
      return { status: "error", error: "mcp_tool action requires toolName (string)" };
    }
    if (!action.toolName.startsWith("zana_")) {
      return { status: "error", error: `mcp_tool toolName must start with "zana_": ${action.toolName}` };
    }
    const orchestratorAction = action.toolName.slice("zana_".length);
    const args = action.toolArgs || {};
    const agentManager = require("@zana-ai/core").agents.manager;
    let workspace = action.cwd || process.env.HOME;
    try {
      const wc = require("@zana-ai/core").project.workspaceContext;
      if (wc?.isInitialized?.()) workspace = wc.getWorkspaceRoot();
    } catch {}
    const result = await agentManager.handleOrchestratorCommand(
      { action: orchestratorAction, ...args },
      () => workspace
    );
    // Some orchestrator handlers return arrays (list_profiles, list_skills, etc.)
    // instead of objects. Always nest the raw result under `data` and lift errors.
    if (result && typeof result === "object" && !Array.isArray(result) && result.error) {
      return { status: "error", error: result.error, data: result };
    }
    return { status: "success", data: result };
  }

  return { status: "error", error: `unknown action type: ${type}` };
}

export async function triggerSchedule(id) {
  const raw = schedulerStore.getSchedule(id);
  if (!raw) return { error: "schedule not found" };
  const schedule = normalizeSchedule(raw);

  // Make sure we're subscribed to agent terminations before any spawn races.
  ensureAgentTerminationListener();

  // Prune stale inflight entries on every fire. Cheap: O(n) over a typically
  // tiny map. Without this, hung/SIGKILL'd agents leak memory linearly with
  // daemon uptime since their AGENT_TERMINATED event never fires.
  sweepInflightAgents();

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
    inflightAgents.set(actionResult.agentId, { scheduleId: id, spawnedAt: Date.now() });
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
    _log().warn(`no backend matched for schedule ${schedule.id} — skipping start`);
    return;
  }

  let handle: any;
  try {
    handle = picked.start(schedule.id, picked.arg, () => {
      triggerSchedule(schedule.id).catch((err: any) => {
        _log().error(`trigger fire failed for ${schedule.id}`, err);
      });
    });
  } catch (err: any) {
    _log().error(`failed to start trigger for ${schedule.id}`, err);
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
      _log().warn(`loadFromDisk: failed to start ${s.id}`, err);
      skipped++;
    }
  }
  _log().info(`loadFromDisk: started=${started} skipped=${skipped} total=${all.length}`);
  return { started, skipped, total: all.length };
}

/** Test-only helper: snapshot the active triggers map. */
export function _getActiveTriggers() {
  return Array.from(triggers.values()).map((t) => ({
    scheduleId: t.scheduleId,
    kind: t.kind,
  }));
}

/**
 * Test-only helper: attach the AGENT_TERMINATED listener to a bus passed in
 * by the test. Avoids the require("@zana-ai/core") path which can mis-resolve
 * under vitest's module loader. Idempotent.
 */
export function _ensureBusListenerForTest(bus?: any, eventName: string = "agent:terminated") {
  if (busSubscribed) return;
  if (!bus) {
    ensureAgentTerminationListener();
    return;
  }
  attachTerminationListener(bus, eventName);
  busSubscribed = true;
}
