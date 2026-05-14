// Core Hive logic shared between Electron (main.js) and headless (bin/hive-headless.js).
// Does NOT import Electron modules — pure Node.js only.

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { bus, EVENTS } from "./event-bus";
import * as pluginLoader from "./plugin-loader";
import { startHookServer, setHivemindModules } from "./hook-server";
import * as hookInstaller from "./hook-installer";
import * as profileStore from "./profile-store";
import * as agentManager from "./agent-manager";
import * as eventLog from "./event-log";
import * as teamStore from "./team-store";
import * as teamManager from "./team-manager";
import * as hiveSkillStore from "./hive-skill-store";
import * as hiveRegistry from "./hive-registry";
import * as hivemindRouter from "./hivemind-router";
import * as hivemindEvents from "./hivemind-events";
import * as hivemindSpawner from "./hivemind-spawner";
import * as persistence from "./persistence";
import * as eventBusService from "./event-bus-service";
import * as runTracker from "./run-tracker";
import * as ticketWatcher from "./ticket-watcher";
import * as healthMonitor from "./health-monitor";
import * as workspaceContext from "./workspace-context";
import * as taskRouter from "./task-router";
import * as vectorMemory from "./vector-memory";
import * as backgroundWorkers from "./background-workers";
import * as goapPlanner from "./goap-planner";
import * as moduleLoader from "./module-loader";

export async function init({ workspace, headless = false, onHook, preferredPort, skipApiServer = false }) {
  const resolvedWorkspace = workspace || process.cwd();
  if (!fs.existsSync(resolvedWorkspace)) {
    fs.mkdirSync(resolvedWorkspace, { recursive: true });
  }

  if (!workspaceContext.isInitialized()) {
    workspaceContext.init(resolvedWorkspace);
  }

  if (headless) {
    process.env.HIVE_HEADLESS = "1";
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
  const recoveredCount = hivemindRouter.recoverFromDisk();
  if (recoveredCount > 0) {
    process.stderr.write(`[core] recovered ${recoveredCount} inbox(es) from disk\n`);
  }

  // Start periodic inbox compaction
  persistence.startPeriodicCompaction(() => {
    const agentIds = agentManager.listAgents().map((a) => a.id);
    const inboxMap = new Map();
    for (const id of agentIds) {
      const msgs = hivemindRouter.peekInbox(id);
      if (msgs.length > 0) inboxMap.set(id, msgs);
    }
    return inboxMap;
  });

  // Wire up hivemind modules for hook-server GET/POST routes
  setHivemindModules({
    router: hivemindRouter,
    events: hivemindEvents,
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

  let hiveId = null;
  let stopHeartbeat = null;

  if (hookServerHandle?.port) {
    process.env.HIVE_HOOK_PORT = String(hookServerHandle.port);

    hiveRegistry.cleanStale();
    hiveId = hiveRegistry.generateHiveId();
    hiveRegistry.register({
      id: hiveId,
      port: hookServerHandle.port,
      workspace: resolvedWorkspace,
      headless,
    });
    stopHeartbeat = hiveRegistry.startHeartbeat(hiveId);
    process.env.HIVE_ID = hiveId;

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
  const hiveModules = {
    hiveId,
    hookServerHandle,
    workspace: resolvedWorkspace,
    agentManager,
    profileStore,
    teamStore,
    teamManager,
    hiveSkillStore,
    hiveRegistry,
    eventLog,
    hivemindRouter,
    hivemindEvents,
    hivemindSpawner,
    taskRouter,
    vectorMemory,
    backgroundWorkers,
    goapPlanner,
    moduleLoader,
  };
  await moduleLoader.init(hiveModules);
  if (headless && !skipApiServer) {
    const apiServer = require("./api-server");
    const apiPort = (hookServerHandle?.port || preferredPort || 47400) + 1;
    apiServerHandle = apiServer.start(hiveModules, apiPort);
  }

  bus.emit(EVENTS.HIVE_READY, { hiveId, workspace: resolvedWorkspace, port: hookServerHandle?.port });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await moduleLoader.shutdown();
    backgroundWorkers.shutdown();
    vectorMemory.shutdown();
    ticketWatcher.stop();
    healthMonitor.stop();
    if (apiServerHandle) { try { require("./api-server").stop(); } catch {} }
    bus.emit(EVENTS.HIVE_SHUTDOWN, { hiveId });
    eventBusService.stop();
    persistence.stopPeriodicCompaction();
    persistence.snapshotAgents(agentManager.listAgents());
    if (stopHeartbeat) {
      try { stopHeartbeat(); } catch (err) {
        console.warn("[core] stopHeartbeat error:", err.message || err);
      }
    }
    if (hiveId) {
      try { hiveRegistry.deregister(hiveId); } catch (err) {
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
    ...hiveModules,
    shutdown,
    apiServerHandle,
  };
}

