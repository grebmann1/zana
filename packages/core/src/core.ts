// Core Zana logic shared between Electron (main.js) and headless (bin/zana.js).
// Does NOT import Electron modules — pure Node.js only.

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { bus, EVENTS } from "./events/bus";
const pluginLoader = require("@zana/extras").plugins.loader;
const _serverPkg: any = require("@zana/server");
const startHookServer = _serverPkg.hooks.server.startHookServer;
const setHivemindModules = _serverPkg.hooks.server.setHivemindModules;
const hookInstaller = _serverPkg.hooks.installer;
import * as profileStore from "./agents/profile-store";
import * as agentManager from "./agents/manager";
import * as eventLog from "./events/log";
// Lazy proxies — @zana/work depends on @zana/core, so eager require here
// would dead-lock during cross-package init.
const teamStore: any = new Proxy({}, { get: (_t, p) => require("@zana/work").teams.store[p] });
const teamManager: any = new Proxy({}, { get: (_t, p) => require("@zana/work").teams.manager[p] });
const skillStore = require("@zana/extras").settings.skillStore;
import * as daemonRegistry from "./daemon/registry";
const _swarmPkg = require("@zana/swarm");
const swarmRouter = _swarmPkg.router;
const swarmEvents = _swarmPkg.events;
const swarmSpawner = _swarmPkg.spawner;
import * as persistence from "./persistence";
import * as eventBusService from "./events/service";
const runTracker: any = new Proxy({}, { get: (_t, p) => require("@zana/work").runs.tracker[p] });
const ticketWatcher: any = new Proxy({}, { get: (_t, p) => require("@zana/work").tickets.watcher[p] });
const healthMonitor = _serverPkg.api.healthMonitor;
import * as workspaceContext from "./project/workspace-context";
const _intel = require("@zana/intelligence");
const taskRouter = _intel.taskRouter;
const vectorMemory = _intel.vectorMemory;
const backgroundWorkers = _intel.backgroundWorkers;
const goapPlanner = _intel.goapPlanner;
import * as moduleLoader from "./modules/loader";

export async function init({ workspace, headless = false, onHook, preferredPort, skipApiServer = false }) {
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
  setHivemindModules({
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

  // Start health monitor
  healthMonitor.init(() => agentManager.listAgents());

  // Initialize intelligence layer
  taskRouter.init();
  vectorMemory.init();
  backgroundWorkers.init();

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
    const apiServer = _serverPkg.api.server;
    const apiPort = (hookServerHandle?.port || preferredPort || 47400) + 1;
    apiServerHandle = apiServer.start(zanaModules, apiPort);
  }

  bus.emit(EVENTS.ZANA_READY, { daemonId, workspace: resolvedWorkspace, port: hookServerHandle?.port });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await moduleLoader.shutdown();
    backgroundWorkers.shutdown();
    vectorMemory.shutdown();
    ticketWatcher.stop();
    healthMonitor.stop();
    if (apiServerHandle) { try { _serverPkg.api.server.stop(); } catch {} }
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

