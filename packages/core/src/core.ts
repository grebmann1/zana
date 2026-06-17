// Core Zana logic shared between Electron (main.js) and headless (bin/zana.js).
// Does NOT import Electron modules — pure Node.js only.

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { bus, EVENTS } from "@zana-ai/contracts";
import * as profileStore from "./agents/profile-store";
import * as agentManager from "./agents/manager";
import * as eventLog from "./events/log";
import * as daemonRegistry from "./daemon/registry";
import * as persistence from "./persistence";
import * as eventBusService from "./events/service";
import * as workspaceContext from "@zana-ai/contracts";
import * as moduleLoader from "./modules/loader";
import * as moduleConfig from "./modules/config";

// Lazy thunks for cross-package modules. Sibling packages depend on @zana-ai/core,
// so eager top-level requires here would deadlock during cross-package init.
// Node's require cache keeps repeat calls cheap.
function _serverPkg(): any { return require("@zana-ai/server"); }
function _swarmPkg(): any { return require("@zana-ai/swarm"); }
function _intel(): any { return require("@zana-ai/intelligence"); }
function _extras(): any { return require("@zana-ai/extras"); }
function _teamStore(): any { return require("@zana-ai/work").teams.store; }
function _teamManager(): any { return require("@zana-ai/work").teams.manager; }
function _runTracker(): any { return require("@zana-ai/work").runs.tracker; }
function _ticketWatcher(): any { return require("@zana-ai/work").tickets.watcher; }
function _schedulingService(): any { return require("@zana-ai/work").scheduling.service; }

export async function init({ workspace, headless = false, onHook, preferredPort, skipApiServer = false }) {
  // Resolve cross-package modules lazily inside init(), so importing @zana-ai/core
  // (e.g. for `config` only) does not eagerly pull in 4 sibling packages.
  const serverPkg = _serverPkg();
  const startHookServer = serverPkg.hooks.server.startHookServer;
  const setSwarmModules = serverPkg.hooks.server.setSwarmModules;
  const hookInstaller = serverPkg.hooks.installer;
  const healthMonitor = serverPkg.api.healthMonitor;
  const swarmPkg = _swarmPkg();
  const swarmRouter = swarmPkg.router;
  const swarmEvents = swarmPkg.events;
  const swarmSpawner = swarmPkg.spawner;
  const intel = _intel();
  const taskRouter = intel.taskRouter;
  const vectorMemory = intel.vectorMemory;
  const backgroundWorkers = intel.backgroundWorkers;
  const goapPlanner = intel.goapPlanner;
  const extras = _extras();
  const pluginLoader = extras.plugins.loader;
  const skillStore = extras.settings.skillStore;
  const teamStore = _teamStore();
  const teamManager = _teamManager();
  if (typeof teamStore.seedDefaults === "function") {
    try { teamStore.seedDefaults(); }
    catch (err: any) { console.warn("[core] team seed failed:", err?.message || err); }
  }
  const runTracker = _runTracker();
  const ticketWatcher = _ticketWatcher();

  const resolvedWorkspace = workspace || process.cwd();
  if (!fs.existsSync(resolvedWorkspace)) {
    fs.mkdirSync(resolvedWorkspace, { recursive: true });
  }

  if (!workspaceContext.isInitialized()) {
    workspaceContext.init(resolvedWorkspace);
  }

  if (headless) {
    process.env.ZANA_HEADLESS = "1";
  }

  eventBusService.init();
  runTracker.init();

  pluginLoader.init();
  eventLog.init(resolvedWorkspace);

  // Crash recovery: detect orphaned agents from previous run. Live processes
  // are re-adopted; dead-but-resumable headless workers (captured claude
  // session id + prompt) are re-spawned via `--resume` so their work survives a
  // daemon crash; the rest are marked lost.
  const { adopted, lost, resumable = [] } = persistence.recoverOrphanedAgents();
  let resumedCount = 0;
  for (const snapshot of resumable) {
    try {
      const newId = agentManager.resumeHeadlessAgent(snapshot);
      if (newId) resumedCount++;
      else {
        // Couldn't resume after all — treat as lost so it isn't silently dropped.
        bus.emit("agent:terminated", { agentId: snapshot.id, reason: "daemon-restart" });
      }
    } catch (err: any) {
      process.stderr.write(`[core] resume failed for ${snapshot.id}: ${err?.message || err}\n`);
      bus.emit("agent:terminated", { agentId: snapshot.id, reason: "daemon-restart" });
    }
  }
  if (adopted.length > 0 || lost.length > 0 || resumedCount > 0) {
    process.stderr.write(
      `[core] crash recovery: ${adopted.length} re-adopted, ${resumedCount} resumed, ${lost.length} lost\n`,
    );
    for (const agent of lost) {
      bus.emit("agent:terminated", { agentId: agent.id, reason: "daemon-restart" });
    }
  }

  // Recover persisted inbox messages from disk
  const recoveredCount = swarmRouter.recoverFromDisk();
  if (recoveredCount > 0) {
    process.stderr.write(`[core] recovered ${recoveredCount} inbox(es) from disk\n`);
  }

  // Start periodic inbox compaction
  persistence.startPeriodicCompaction(() => {
    const agentIds = agentManager.listAgents().map((a) => a.id);
    const inboxMap = new Map();
    for (const id of agentIds) {
      const msgs = swarmRouter.peekInbox(id);
      if (msgs.length > 0) inboxMap.set(id, msgs);
    }
    return inboxMap;
  });

  // Wire up swarm modules for hook-server GET/POST routes
  setSwarmModules({
    router: swarmRouter,
    events: swarmEvents,
    getAgents: () => agentManager.listAgents(),
  });

  const hookServerHandle = await startHookServer(
    (payload) => {
      agentManager.updateAgentFromHook(payload);
      eventLog.append(payload);
      if (onHook) onHook(payload);
    },
    (command) => agentManager.handleOrchestratorCommand(command, () => resolvedWorkspace),
    preferredPort,
  );

  let daemonId = null;
  let stopHeartbeat = null;

  if (hookServerHandle?.port) {
    process.env.ZANA_HOOK_PORT = String(hookServerHandle.port);

    daemonRegistry.cleanStale();
    daemonId = daemonRegistry.generateDaemonId();
    daemonRegistry.register({
      id: daemonId,
      port: hookServerHandle.port,
      workspace: resolvedWorkspace,
      headless,
    });
    stopHeartbeat = daemonRegistry.startHeartbeat(daemonId);
    process.env.ZANA_ID = daemonId;

    try {
      if (!hookInstaller.isHooksInstalled()) {
        hookInstaller.installHooks(hookServerHandle.port);
      }
      hookInstaller.installMcpServer(hookServerHandle.port);
    } catch (err) {
      console.warn("[core] auto-install hooks/mcp failed:", err.message);
    }
  }

  // Start ticket-watcher automation (works in both Electron and headless mode)
  try {
    const projectPaths = workspaceContext.getProjectPaths();
    ticketWatcher.init({
      ticketsDirectory: projectPaths.ticketsDir,
      configPath: path.join(projectPaths.projectDir, "automation.json"),
      spawnAgent: (profileId, prompt, ticketId) => {
        return agentManager.handleOrchestratorCommand(
          { action: "spawn_agent", profileId, prompt, parentAgentId: null },
          () => resolvedWorkspace
        );
      },
    });
  } catch (err) {
    console.warn("[core] ticket-watcher init failed:", err.message);
  }

  // Hydrate persisted schedules — every <workspace>/.zana/scheduler/*.{yml,json}
  // with enabled=true gets its trigger registered so cron/interval schedules
  // survive daemon restarts.
  try {
    const schedulingService = _schedulingService();
    schedulingService.loadFromDisk();
  } catch (err: any) {
    console.warn("[core] scheduling.loadFromDisk failed:", err?.message || err);
  }

  // Start health monitor
  healthMonitor.init(() => agentManager.listAgents());

  // Initialize intelligence layer
  taskRouter.init();
  vectorMemory.init();
  backgroundWorkers.init();

  // Auto-assign a profile on ticket creation. `work` deliberately does not
  // depend on `intelligence` (it would deepen the require-cycle), so the
  // routing bridge lives here in core where both the task router and the
  // ticket service are already in scope. The router picks the best-fit
  // profile; if it clears the confidence floor we bind it, otherwise the
  // service tags the ticket `needs-triage` for a human. An already-bound
  // profile (explicit human intent) is never overridden by the service.
  try {
    // Shared routing for a ticket that has no bound profile yet. Runs on
    // creation AND on update (so a ticket relabeled `architecture` *later* still
    // escalates — escalation isn't a create-time-only decision). Idempotent: an
    // already-assigned or already-parked ticket short-circuits.
    const routeTicket = (ticketId: string, reason: string) => {
      try {
        const sys = moduleConfig.getModuleConfig("system") || {};
        if (sys.autoAssignProfile === false) return;
        if (!ticketId) return;
        const ticketService = require("@zana-ai/work").tickets.service;
        const ticket = ticketService.getTicket(ticketId);
        if (!ticket || ticket.assigneeProfileId) return;
        const labels = Array.isArray(ticket.labels) ? ticket.labels : [];
        // Already parked for a human — don't re-route.
        if (labels.includes("awaiting-decision")) return;

        // Escalation gate (#6): a ticket that changes a core invariant goes to
        // the design-only lane (architect + ADR, parked for a human) instead of
        // straight to an implementer. EXPLICIT escalation labels only — low
        // router confidence is NOT escalation (usually just "no history yet"),
        // so that falls through to assignProfile/needs-triage. Labels are
        // configurable via system.escalationLabels.
        const escalationLabels = Array.isArray(sys.escalationLabels)
          ? sys.escalationLabels
          : ["architecture", "needs-decision", "invariant"];
        if (labels.some((l: string) => escalationLabels.includes(l))) {
          ticketService.escalateForDesign(ticketId, `escalation label (${reason})`, "auto-router");
          return;
        }

        // Otherwise bind the best-fit profile if confident, else needs-triage.
        const ranked = taskRouter.route(ticket) || [];
        const floor = typeof sys.autoAssignConfidence === "number" ? sys.autoAssignConfidence : 0.15;
        const top = ranked[0];
        const profileId = top && top.score >= floor ? top.profileId : null;
        ticketService.assignProfile(ticketId, profileId, "auto-router");
      } catch (err: any) {
        console.warn("[core] auto-route failed:", err?.message || err);
      }
    };
    bus.on("ticket:created", (msg: any) => routeTicket(msg?.ticketId, "created"));
    // Late-label escalation: only react to label edits, and only to escalate
    // (never to re-route a routine update). assignProfile/escalateForDesign are
    // both idempotent + no-op on an already-assigned ticket, so this is safe.
    bus.on("ticket:updated", (msg: any) => {
      const fields = Array.isArray(msg?.fields) ? msg.fields : [];
      if (fields.includes("labels")) routeTicket(msg?.ticketId, "relabeled");
    });
  } catch (err: any) {
    console.warn("[core] auto-router wiring failed:", err?.message || err);
  }

  // Reap orphaned headless claude processes from earlier daemon runs.
  // (See packages/core/src/agents/zombie-reaper.ts for the heuristic.)
  const zombieReaper = require("./agents/zombie-reaper");
  zombieReaper.start();

  // Reconcile orphaned tickets — closes stale `in-progress`/`review`/`rework`
  // tickets whose assignees are no longer alive, and any `blocked` tickets
  // that have been idle past the stale threshold. See
  // packages/work/src/tickets/sweeper.ts. Cross-package require so wrap defensively.
  try { require("@zana-ai/work").tickets.sweeper.start(); }
  catch (err: any) { console.warn("[core] ticket-sweeper.start failed:", err?.message || err); }

  // Start REST API server (headless/daemon mode)
  let apiServerHandle = null;
  const zanaModules = {
    daemonId,
    hookServerHandle,
    workspace: resolvedWorkspace,
    agentManager,
    profileStore,
    teamStore,
    teamManager,
    skillStore,
    daemonRegistry,
    eventLog,
    swarmRouter,
    swarmEvents,
    swarmSpawner,
    taskRouter,
    vectorMemory,
    backgroundWorkers,
    goapPlanner,
    moduleLoader,
  };
  await moduleLoader.init(zanaModules);
  if (headless && !skipApiServer) {
    const apiServer = serverPkg.api.server;
    const apiPort = (hookServerHandle?.port || preferredPort || 47400) + 1;
    apiServerHandle = apiServer.start(zanaModules, apiPort);
    if (daemonId && hookServerHandle?.port) {
      daemonRegistry.register({
        id: daemonId,
        port: hookServerHandle.port,
        apiPort,
        workspace: resolvedWorkspace,
        headless,
      });
    }
  }

  bus.emit(EVENTS.ZANA_READY, { daemonId, workspace: resolvedWorkspace, port: hookServerHandle?.port });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await moduleLoader.shutdown();
    try { require("./agents/zombie-reaper").stop(); } catch {}
    try { require("@zana-ai/work").tickets.sweeper.stop(); } catch {}
    backgroundWorkers.shutdown();
    vectorMemory.shutdown();
    ticketWatcher.stop();
    try { _schedulingService().stopAll(); } catch {}
    healthMonitor.stop();
    if (apiServerHandle) { try { serverPkg.api.server.stop(); } catch {} }
    bus.emit(EVENTS.ZANA_SHUTDOWN, { daemonId });
    eventBusService.stop();
    persistence.stopPeriodicCompaction();
    persistence.snapshotAgents(agentManager.listAgents());
    if (stopHeartbeat) {
      try { stopHeartbeat(); } catch (err) {
        console.warn("[core] stopHeartbeat error:", err.message || err);
      }
    }
    if (daemonId) {
      try { daemonRegistry.deregister(daemonId); } catch (err) {
        console.warn("[core] deregister error:", err.message || err);
      }
    }
    try { hookServerHandle?.stop(); } catch (err) {
      console.warn("[core] hookServer.stop error:", err.message || err);
    }
    try { eventLog.close(); } catch (err) {
      console.warn("[core] eventLog.close error:", err.message || err);
    }
  }

  return {
    ...zanaModules,
    shutdown,
    apiServerHandle,
  };
}

