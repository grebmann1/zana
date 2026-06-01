// Core Zana logic shared between Electron (main.js) and headless (bin/zana.js).
// Does NOT import Electron modules — pure Node.js only.

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { bus, EVENTS } from "./events/bus";
import * as profileStore from "./agents/profile-store";
import * as agentManager from "./agents/manager";
import * as eventLog from "./events/log";
import * as daemonRegistry from "./daemon/registry";
import * as persistence from "./persistence";
import * as eventBusService from "./events/service";
import * as workspaceContext from "./project/workspace-context";
import * as moduleLoader from "./modules/loader";

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

  // Crash recovery: detect orphaned agents from previous run
  const { adopted, lost } = persistence.recoverOrphanedAgents();
  if (adopted.length > 0 || lost.length > 0) {
    process.stderr.write(`[core] crash recovery: ${adopted.length} re-adopted, ${lost.length} lost\n`);
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

  // Reap orphaned headless claude processes from earlier daemon runs.
  // (See packages/core/src/agents/zombie-reaper.ts for the heuristic.)
  const zombieReaper = require("./agents/zombie-reaper");
  zombieReaper.start();

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

