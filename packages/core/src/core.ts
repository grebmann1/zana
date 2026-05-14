// Core Zana logic shared between Electron (main.js) and headless (bin/zana.js).
// Does NOT import Electron modules — pure Node.js only.

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { bus, EVENTS } from "./events/bus";
const pluginLoader = require("@zana/extras").plugins.loader;
import { startHookServer, setHivemindModules } from "./hooks/server";
import * as hookInstaller from "./hooks/installer";
import * as profileStore from "./agents/profile-store";
import * as agentManager from "./agents/manager";
import * as eventLog from "./events/log";
import * as teamStore from "./teams/store";
import * as teamManager from "./teams/manager";
const skillStore = require("@zana/extras").settings.skillStore;
import * as daemonRegistry from "./daemon/registry";
const _swarmPkg = require("@zana/swarm");
const swarmRouter = _swarmPkg.router;
const swarmEvents = _swarmPkg.events;
const swarmSpawner = _swarmPkg.spawner;
import * as persistence from "./persistence";
import * as eventBusService from "./events/service";
import * as runTracker from "./runs/tracker";
import * as ticketWatcher from "./tickets/watcher";
import * as healthMonitor from "./api/health-monitor";
import * as workspaceContext from "./project/workspace-context";
import * as taskRouter from "./intelligence/task-router";
import * as vectorMemory from "./intelligence/vector-memory";
import * as backgroundWorkers from "./intelligence/background-workers";
import * as goapPlanner from "./intelligence/goap-planner";
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
    const apiServer = require("./api/server");
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
    if (apiServerHandle) { try { require("./api/server").stop(); } catch {} }
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

