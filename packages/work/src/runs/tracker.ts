import * as crypto from "node:crypto";
function _core() { return require("@zana-ai/core"); }
function _bus(): any { return _core().events.bus; }
function _EVENTS(): any { return _core().events.EVENTS; }
function _statsEngine(): any { return _core().events.stats; }
import * as runStore from "./store";

let currentRun = null;
let runEvents = [];
let liveStatsInterval = null;
let changeListeners = [];
let statsListeners = [];

function notifyChange() {
  const snapshot = currentRun;
  for (const cb of changeListeners) {
    try { cb(snapshot); } catch {}
  }
}

function notifyStats(stats) {
  for (const cb of statsListeners) {
    try { cb(stats); } catch {}
  }
}

export function init() {
  _bus().on(_EVENTS().TEAM_STARTED, (payload) => {
    if (!currentRun) {
      startRun({
        teamId: payload.teamId,
        teamName: payload.teamName,
        workspace: process.env.ZANA_WORKSPACE || process.cwd(),
        daemonId: process.env.ZANA_ID || "default",
      });
    }
  });

  _bus().on(_EVENTS().TEAM_STOPPED, (payload) => {
    if (currentRun && currentRun.teamId === payload.teamId) {
      endRun(currentRun.id, payload.reason === "user" ? "aborted" : "completed");
    }
  });

  _bus().on(_EVENTS().AGENT_SPAWNED, (payload) => {
    if (!currentRun) return;
    const agentEntry = {
      id: payload.agentId,
      profileId: payload.profileId || "unknown",
      profileName: payload.profileName || payload.profileId || "unknown",
      profileIcon: payload.profileIcon || "",
      mode: payload.mode || "headless",
      spawnedAt: Date.now(),
      terminatedAt: null,
      exitReason: null,
      toolCalls: 0,
    };
    currentRun.agents.push(agentEntry);
    runEvents.push({ type: "agent:spawned", timestamp: Date.now(), payload });
    notifyChange();
  });

  _bus().on(_EVENTS().AGENT_TERMINATED, (payload) => {
    if (!currentRun) return;
    const agent = currentRun.agents.find((a) => a.id === payload.agentId);
    if (agent) {
      agent.terminatedAt = Date.now();
      agent.exitReason = payload.reason || null;
    }
    runEvents.push({ type: "agent:terminated", timestamp: Date.now(), payload });
    notifyChange();

    // Auto-end run if this was the orchestrator
    if (currentRun.orchestratorAgentId === payload.agentId) {
      setTimeout(() => {
        if (currentRun && currentRun.id) {
          endRun(currentRun.id, payload.reason === "errored" ? "errored" : "completed");
        }
      }, 3000);
    }
  });

  _bus().on(_EVENTS().AGENT_HOOK, (payload) => {
    if (!currentRun) return;
    runEvents.push({ type: "agent:hook", timestamp: Date.now(), payload });

    if (payload.hook_event_name === "PostToolUse") {
      const agent = currentRun.agents.find((a) => a.id === payload.agentId || a.terminalId === payload.zana_terminal_id);
      if (agent) agent.toolCalls++;
      currentRun.stats.totalToolCalls++;

      const tool = payload.tool_name || "unknown";
      currentRun.stats.toolBreakdown[tool] = (currentRun.stats.toolBreakdown[tool] || 0) + 1;

      // Track file outputs
      if ((tool === "Write" || tool === "Edit") && payload.tool_input?.file_path) {
        const fp = payload.tool_input.file_path;
        if (!currentRun.filesProduced.includes(fp)) {
          currentRun.filesProduced.push(fp);
        }
      }
    }
  });

  _bus().on("ticket:created", (payload) => {
    if (!currentRun) return;
    currentRun.tickets.total++;
    if (payload.ticketId) currentRun.tickets.ids.push(payload.ticketId);
    runEvents.push({ type: "ticket:created", timestamp: Date.now(), payload });
    notifyChange();
  });

  _bus().on("ticket:completed", (payload) => {
    if (!currentRun) return;
    currentRun.tickets.completed++;
    runEvents.push({ type: "ticket:completed", timestamp: Date.now(), payload });
    notifyChange();
  });
}

export function startRun({ teamId, teamName, workspace, daemonId, orchestratorAgentId }) {
  const id = crypto.randomUUID();
  currentRun = {
    id,
    daemonId: daemonId || "default",
    workspace: workspace || process.cwd(),
    teamId: teamId || null,
    teamName: teamName || null,
    orchestratorAgentId: orchestratorAgentId || null,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    agents: [],
    tickets: { total: 0, completed: 0, ids: [] },
    sprintId: null,
    sprintName: null,
    filesProduced: [],
    subDaemons: [],
    stats: {
      totalAgents: 0,
      peakConcurrentAgents: 0,
      totalToolCalls: 0,
      toolBreakdown: {},
      profileBreakdown: {},
      ticketCompletionRate: 0,
      eventCount: 0,
    },
  };

  runEvents = [];
  runStore.saveRun(currentRun);

  _bus().emit(_EVENTS().RUN_STARTED, { runId: id, teamId, teamName });

  liveStatsInterval = setInterval(() => {
    if (currentRun) {
      const stats = getLiveStats();
      notifyStats(stats);
    }
  }, 5000);

  notifyChange();
  return currentRun;
}

export function endRun(runId, status = "completed") {
  if (!currentRun || currentRun.id !== runId) return null;

  currentRun.status = status;
  currentRun.endedAt = Date.now();
  currentRun.durationMs = currentRun.endedAt - currentRun.startedAt;

  // Finalize stats
  currentRun.stats.totalAgents = currentRun.agents.length;
  currentRun.stats.peakConcurrentAgents = _statsEngine().computePeakConcurrentAgents(runEvents);
  currentRun.stats.eventCount = runEvents.length;
  currentRun.stats.ticketCompletionRate =
    currentRun.tickets.total > 0 ? currentRun.tickets.completed / currentRun.tickets.total : 0;
  currentRun.stats.profileBreakdown = _statsEngine().computeProfileBreakdown(runEvents);

  runStore.saveRun(currentRun);

  _bus().emit(_EVENTS().RUN_ENDED, { runId, status, durationMs: currentRun.durationMs });

  if (liveStatsInterval) {
    clearInterval(liveStatsInterval);
    liveStatsInterval = null;
  }

  const finishedRun = currentRun;
  currentRun = null;
  runEvents = [];
  notifyChange();
  return finishedRun;
}

export function getCurrentRun() {
  return currentRun;
}

export function getLiveStats() {
  if (!currentRun) return null;
  return {
    ...currentRun.stats,
    durationMs: Date.now() - currentRun.startedAt,
    activeAgents: currentRun.agents.filter((a) => !a.terminatedAt).length,
    filesCount: currentRun.filesProduced.length,
    ticketsTotal: currentRun.tickets.total,
    ticketsCompleted: currentRun.tickets.completed,
  };
}

export function getRunStats(runId) {
  const run = runStore.getRun(runId);
  if (!run) return null;
  return run.stats;
}

export function getRunTimeline(runId) {
  if (currentRun && currentRun.id === runId) {
    return {
      agentTimeline: _statsEngine().computeAgentTimeline(runEvents),
      ticketFlow: _statsEngine().computeTicketFlow(runEvents),
      throughput: _statsEngine().computeThroughput(runEvents),
    };
  }
  return { agentTimeline: [], ticketFlow: [], throughput: [] };
}

export function exportRun(runId, format = "json") {
  const run = runStore.getRun(runId);
  if (!run) return null;

  const isCurrentRun = currentRun && currentRun.id === runId;
  const events = isCurrentRun ? runEvents : [];

  if (format === "ndjson") {
    const lines = [
      JSON.stringify({ type: "run", data: run }),
      ...events.map((ev) => JSON.stringify({ type: "event", data: ev })),
    ];
    return {
      filename: `run-${runId.slice(0, 8)}-${new Date(run.startedAt).toISOString().slice(0, 10)}.ndjson`,
      data: lines.join("\n") + "\n",
    };
  }

  return {
    filename: `run-${runId.slice(0, 8)}-${new Date(run.startedAt).toISOString().slice(0, 10)}.json`,
    data: JSON.stringify({ run, events }, null, 2),
  };
}

export function listRuns(opts) {
  return runStore.listRuns(opts);
}

export function onChange(cb) {
  changeListeners.push(cb);
  return () => { changeListeners = changeListeners.filter((l) => l !== cb); };
}

export function onStatsUpdate(cb) {
  statsListeners.push(cb);
  return () => { statsListeners = statsListeners.filter((l) => l !== cb); };
}

