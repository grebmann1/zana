import { buildInteractiveCommand, spawnHeadless } from "./spawner";
import { selectModel } from "./model-router";
import * as crypto from "node:crypto";
import * as os from "node:os";

// Lazy-load pty-host only when interactive mode is needed (requires node-pty native module)
let _ptyHost = null;
function getPtyHost() {
  if (!_ptyHost) {
    try {
      _ptyHost = require("./pty-host");
    } catch (err) {
      throw new Error(
        `pty-host unavailable (node-pty not installed). Interactive mode requires node-pty. Error: ${err.message}`
      );
    }
  }
  return _ptyHost;
}
import * as profileStore from "./profile-store";
const skillStore: any = new Proxy({}, { get: (_t, p) => require("@zana/extras").settings.skillStore[p] });
const swarmPkg = require("@zana/swarm");
const swarmRouter = swarmPkg.router;
const swarmEvents = swarmPkg.events;
const swarmSpawner = swarmPkg.spawner;

// Lazy getters for cross-package modules — Node's require cache makes repeat calls cheap.
// Do NOT memoize into module-scope vars; that defeats the cycle break.
function _ticketService() { return require("@zana/work").tickets.service; }
function _ticketStore() { return require("@zana/work").tickets.store; }
function _schedulerService() { return require("@zana/work").scheduling.service; }
function _checkpointStore() { return require("@zana/work").runs.checkpoint.store; }
function _checkpointResume() { return require("@zana/work").runs.checkpoint.resume; }
function _artifactStore() { return require("@zana/work").runs.artifacts; }
import * as persistence from "../persistence";
import { bus, EVENTS } from "../events/bus";
import { MAX_CONCURRENT_AGENTS } from "../config";
import * as moduleConfig from "../modules/config";

function getMaxConcurrentAgents() {
  const cfg = moduleConfig.get();
  return Number(process.env.ZANA_MAX_WORKERS) || cfg?.system?.maxConcurrentAgents || MAX_CONCURRENT_AGENTS;
}

function checkSystemResources() {
  const cfg = moduleConfig.get()?.system;
  const cpuThreshold = cfg?.cpuLoadThreshold ?? 0.8;
  const minFreePct = cfg?.minFreeMemoryPct ?? 10;

  const load1m = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const maxLoad = cpuCount * cpuThreshold;
  if (load1m > maxLoad) {
    return `CPU load too high: ${load1m.toFixed(2)} exceeds threshold ${maxLoad.toFixed(2)} (${cpuCount} cores x ${(cpuThreshold * 100).toFixed(0)}%)`;
  }

  const freePct = (os.freemem() / os.totalmem()) * 100;
  if (freePct < minFreePct) {
    return `memory too low: ${freePct.toFixed(1)}% free, minimum is ${minFreePct}%`;
  }

  return null;
}

const agents = new Map();

let changeListeners = [];

let snapshotTimer = null;

function notifyChange() {
  const snapshot = listAgents();
  for (const cb of changeListeners) {
    try {
      cb(snapshot);
    } catch (err) {
      console.warn("[agent-manager] listener callback error:", err.message || err);
    }
  }
  // Debounced snapshot to disk
  if (!snapshotTimer) {
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      persistence.snapshotAgents(listAgents());
    }, 2000);
  }
}

export function spawnInteractive(profile, options = {}) {
  const agentId = crypto.randomUUID();
  const terminalId = options.terminalId || `zana-${agentId.slice(0, 8)}`;
  const cwd = options.cwd || profile.defaultCwd || process.env.HOME;

  const { command, args } = buildInteractiveCommand(profile, {
    name: `${profile.displayName} [${agentId.slice(0, 6)}]`,
    ...options,
  });

  // Spawn terminal first
  getPtyHost().spawnTerminal({
    terminalId,
    cwd,
    cols: options.cols || 120,
    rows: options.rows || 30,
  });

  const agent = {
    id: agentId,
    profileId: profile.id,
    profileName: profile.displayName,
    profileIcon: profile.icon || "🤖",
    terminalId,
    mode: "interactive",
    state: "spawning",
    model: profile.model || "default",
    pid: null,
    spawnedAt: Date.now(),
    lastActivity: Date.now(),
    toolsAllowed: profile.allowedTools?.length || null,
    toolsTotal: null,
    tokenCount: 0,
    lastAction: "Initializing...",
  };

  agents.set(agentId, agent);

  // Send the claude command to the PTY
  const fullCommand = `${command} ${args.map((a) => a.includes(" ") ? `"${a}"` : a).join(" ")}\n`;

  setTimeout(() => {
    getPtyHost().writeTerminal(terminalId, fullCommand);
    agent.state = "active";
    agent.lastAction = "Claude session started";
    agent.lastActivity = Date.now();
    notifyChange();
  }, 300);

  notifyChange();
  bus.emit(EVENTS.AGENT_SPAWNED, { agentId, profileId: profile.id, mode: "interactive" });

  return { agentId, terminalId };
}

export function updateAgentFromHook(payload) {
  const terminalId = payload.zana_terminal_id;
  if (!terminalId) return;

  const agent = Array.from(agents.values()).find(
    (a) => a.terminalId === terminalId,
  );
  if (!agent) return;

  agent.lastActivity = Date.now();

  const event = payload.hook_event_name;
  if (event === "PreToolUse" || event === "PostToolUse") {
    const toolName = payload.tool_name || payload.tool?.name || "unknown";
    agent.lastAction = `${event === "PreToolUse" ? "Running" : "Completed"}: ${toolName}`;
  } else if (event === "Stop") {
    agent.state = "idle";
    agent.lastAction = "Waiting for input...";
  } else if (event === "SessionStart") {
    agent.state = "active";
    agent.lastAction = "Session started";
  } else if (event === "SessionEnd") {
    agent.state = "terminated";
    agent.lastAction = "Session ended";
  }

  bus.emit(EVENTS.AGENT_HOOK, {
    agentId: agent.id,
    zana_terminal_id: terminalId,
    hook_event_name: event,
    tool_name: payload.tool_name || payload.tool?.name,
    tool_input: payload.tool_input,
    duration_ms: payload.duration_ms,
  });

  notifyChange();
}

export function killAgent(agentId) {
  const agent = agents.get(agentId);
  if (!agent) return false;

  if (agent.terminalId) {
    getPtyHost().killTerminal(agent.terminalId);
  }

  agent.state = "terminated";
  agent.lastAction = "Killed by user";
  notifyChange();
  bus.emit(EVENTS.AGENT_TERMINATED, { agentId, profileId: agent.profileId, reason: "killed" });

  setTimeout(() => {
    agents.delete(agentId);
    notifyChange();
  }, 3000);

  return true;
}

export function getAgent(agentId) {
  return agents.get(agentId) || null;
}

export function listAgents() {
  return Array.from(agents.values());
}

export function writeToAgent(agentId, jsonMessage) {
  const agent = agents.get(agentId);
  if (!agent?.childProcess?.stdin?.writable) return false;
  agent.childProcess.stdin.write(JSON.stringify(jsonMessage) + "\n");
  return true;
}

export function onAgentsChange(cb) {
  changeListeners.push(cb);
  return () => {
    changeListeners = changeListeners.filter((l) => l !== cb);
  };
}

export function spawnHeadlessAgent(profile, options = {}) {
  const agentId = crypto.randomUUID();
  const terminalId = options.terminalId || `zana-hl-${agentId.slice(0, 8)}`;
  const cwd = options.cwd || profile.defaultCwd || process.env.HOME;

  // 3-tier model routing: auto-select cheapest capable model
  const routedModel = selectModel(options.prompt, {
    category: profile.category,
    model: profile.model,
  });
  const routedProfile = profile.model ? profile : { ...profile, model: routedModel };

  const child = spawnHeadless(routedProfile, {
    name: `${profile.displayName} [${agentId.slice(0, 6)}]`,
    cwd,
    prompt: options.prompt,
    terminalId,
    profileId: profile.id,
    multiTurn: options.multiTurn || false,
  });

  const agent = {
    id: agentId,
    profileId: profile.id,
    profileName: profile.displayName,
    profileIcon: profile.icon || "🤖",
    terminalId,
    mode: "headless",
    state: "active",
    model: routedProfile.model || "default",
    pid: child.pid,
    spawnedAt: Date.now(),
    lastActivity: Date.now(),
    toolsAllowed: profile.allowedTools?.length || null,
    toolsTotal: null,
    tokenCount: 0,
    lastAction: "Running headless...",
    parentAgentId: options.parentAgentId || null,
    result: null,
  };

  agent.childProcess = child;

  agents.set(agentId, agent);
  notifyChange();
  bus.emit(EVENTS.AGENT_SPAWNED, { agentId, profileId: profile.id, mode: "headless" });

  let outputBuffer = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    outputBuffer += text;
    agent.lastActivity = Date.now();

    // Parse stream-json lines for status
    const lines = text.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "assistant" && msg.message?.content) {
          const textBlocks = msg.message.content.filter((b) => b.type === "text");
          if (textBlocks.length > 0) {
            agent.result = textBlocks.map((b) => b.text).join("\n");
          }
        }
        if (msg.type === "result" && msg.result) {
          agent.result = msg.result;
        }
      } catch (err) {
        // Non-JSON lines from stdout are normal (e.g. progress indicators)
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (text.includes("error") || text.includes("Error")) {
      agent.lastAction = `Error: ${text.slice(0, 80)}`;
    }
  });

  // Configurable timeout for headless agents
  const AGENT_TIMEOUT_MS = (moduleConfig.getModuleConfig("system")?.agentTimeoutMinutes || 10) * 60 * 1000;
  const timeoutHandle = setTimeout(() => {
    if (getAgent(agentId)?.state === "active") {
      console.warn(`[agent-manager] agent ${agentId} timed out after ${AGENT_TIMEOUT_MS / 60000}min, killing`);
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 5000);
    }
  }, AGENT_TIMEOUT_MS);

  child.on("error", (err) => {
    clearTimeout(timeoutHandle);
    console.error(`[agent-manager] spawn error for ${agentId}:`, err.message);
    agent.state = "error";
    agent.lastAction = `Spawn error: ${err.message}`;
    notifyChange();
    bus.emit(EVENTS.AGENT_TERMINATED, { agentId, profileId: profile.id, reason: "spawn-error", error: err.message });
    const resilienceMod = require("../modules/loader").getModule?.("resilience");
    resilienceMod?.api?.recordFailure?.("agent-spawn");
  });

  child.on("close", (code) => {
    clearTimeout(timeoutHandle);
    agent.state = code === 0 ? "terminated" : "errored";
    agent.lastAction = code === 0 ? "Completed" : `Exited (code ${code})`;
    notifyChange();
    bus.emit(EVENTS.AGENT_TERMINATED, { agentId, profileId: profile.id, reason: code === 0 ? "completed" : "errored", exitCode: code, output: agent.result || null });
    if (code === 0) {
      const resilienceMod = require("../modules/loader").getModule?.("resilience");
      resilienceMod?.api?.recordSuccess?.("agent-spawn");
    }
  });

  return { agentId, terminalId };
}

export async function handleOrchestratorCommand(payload, getWorkspaceFn) {
  const { action, ...params } = payload;

  switch (action) {
    case "spawn_agent": {
      const resilienceMod = require("../modules/loader").getModule?.("resilience");
      if (resilienceMod?.api?.isOpen?.("agent-spawn")) {
        return { error: "Circuit breaker open: too many recent spawn failures. Try again later." };
      }
      const resourceError = checkSystemResources();
      if (resourceError) {
        return { error: `system overloaded: ${resourceError}` };
      }
      const { profileId, prompt, parentAgentId } = params;
      if (parentAgentId) {
        const allAgents = listAgents();
        const childCount = allAgents.filter(a => a.parentAgentId === parentAgentId && a.state !== "terminated").length;
        const maxWorkers = getMaxConcurrentAgents();
        if (childCount >= maxWorkers) {
          return { error: `max concurrent workers reached (${maxWorkers}). Wait for existing workers to complete.` };
        }
      }
      const profile = profileStore.getProfile(profileId);
      if (!profile) return { error: `profile not found: ${profileId}` };
      const cwd = getWorkspaceFn ? getWorkspaceFn() : process.env.HOME;
      const result = spawnHeadlessAgent(profile, { prompt, cwd, parentAgentId });
      return { agentId: result.agentId, status: "spawned" };
    }
    case "spawn_agent_validated": {
      const { profileId, prompt, parentAgentId, guardrails: guardrailConfigs, maxRetries } = params;
      if (parentAgentId) {
        const allAgents = listAgents();
        const childCount = allAgents.filter(a => a.parentAgentId === parentAgentId && a.state !== "terminated").length;
        const maxWorkers = getMaxConcurrentAgents();
        if (childCount >= maxWorkers) {
          return { error: `max concurrent workers reached (${maxWorkers}). Wait for existing workers to complete.` };
        }
      }
      const profile = profileStore.getProfile(profileId);
      if (!profile) return { error: `profile not found: ${profileId}` };
      const cwd = getWorkspaceFn ? getWorkspaceFn() : process.env.HOME;
      const guardrails = require("../guardrails/index");
      const result = await guardrails.spawnValidatedAgent(
        { spawnHeadlessAgent, getAgent },
        profile,
        { prompt, cwd, parentAgentId, maxRetries },
        guardrailConfigs || []
      );
      return {
        agentId: result.agentId,
        status: result.guardrailsPassed ? "completed" : "validation_failed",
        attempts: result.attempts,
        guardrailsPassed: result.guardrailsPassed,
        output: result.output,
        parsedOutput: result.parsedOutput || null,
        error: result.error || null,
      };
    }
    case "list_agents": {
      return listAgents().map((a) => ({
        id: a.id,
        profile: a.profileName,
        state: a.state,
        lastAction: a.lastAction,
        mode: a.mode,
      }));
    }
    case "agent_status": {
      const agent = getAgent(params.agentId);
      if (!agent) return { error: "agent not found" };
      return {
        id: agent.id,
        state: agent.state,
        lastAction: agent.lastAction,
        mode: agent.mode,
        uptime: Date.now() - agent.spawnedAt,
      };
    }
    case "agent_result": {
      const agent = getAgent(params.agentId);
      if (!agent) return { error: "agent not found" };
      return {
        id: agent.id,
        completed: agent.state === "terminated",
        result: agent.result || null,
        state: agent.state,
      };
    }
    case "kill_agent": {
      return { ok: killAgent(params.agentId) };
    }
    case "list_profiles": {
      return profileStore.listProfiles().map((p) => ({
        id: p.id,
        name: p.displayName,
        icon: p.icon,
        category: p.category,
        description: p.description,
        model: p.model,
      }));
    }
    case "get_profile": {
      const profile = profileStore.getProfile(params.profileId);
      if (!profile) return { error: `profile not found: ${params.profileId}` };
      return profile;
    }
    case "save_profile": {
      const saved = profileStore.saveProfile(params.profile);
      return { ok: true, id: saved.id, displayName: saved.displayName };
    }
    case "delete_profile": {
      const ok = profileStore.deleteProfile(params.profileId);
      return { ok };
    }
    case "list_skills": {
      return skillStore.listSkills();
    }
    case "get_skill": {
      const skill = skillStore.getSkill(params.skillId);
      if (!skill) return { error: `skill not found: ${params.skillId}` };
      return skill;
    }
    case "save_skill": {
      const saved = skillStore.saveSkill(params.skill);
      return { ok: true, id: saved.id, name: saved.name };
    }
    case "delete_skill": {
      const ok = skillStore.deleteSkill(params.skillId);
      return { ok };
    }
    case "toggle_skill": {
      const ok = skillStore.toggleSkill(params.skillId, params.enabled);
      return { ok };
    }

    // --- Ticketing ---
    case "ticket_create": {
      return _ticketService().createTicket(params);
    }
    case "ticket_list": {
      return _ticketService().listTickets(params);
    }
    case "ticket_get": {
      return _ticketService().getTicket(params.ticketId);
    }
    case "ticket_claim": {
      return _ticketService().claimTicket(params.ticketId, params.agentId, params.agentName, params.profileId);
    }
    case "ticket_update_status": {
      return _ticketService().updateStatus(params.ticketId, params.status, params.updatedBy);
    }
    case "ticket_comment": {
      return _ticketService().addComment(params.ticketId, params.authorId, params.authorName, params.body);
    }
    case "ticket_complete": {
      return _ticketService().completeTicket(params.ticketId, params.resultSummary, params.completedBy);
    }
    case "ticket_edit": {
      const { ticketId, updatedBy, ...fields } = params;
      // Remove undefined values
      const cleanFields = Object.fromEntries(
        Object.entries(fields).filter(([_, v]) => v !== undefined)
      );
      return _ticketService().updateTicket(ticketId, cleanFields, updatedBy);
    }
    case "ticket_add_to_sprint": {
      return _ticketService().addTicketToSprint(params.ticketId, params.sprintId);
    }
    case "ticket_update": {
      const ticketService = _ticketService();
      const ticketStore = _ticketStore();
      const fs = require("node:fs");
      const path = require("node:path");
      const workspaceContext = require("../project/workspace-context");

      const ticket = ticketService.getTicket(params.ticketId);
      if (!ticket) return { error: "ticket not found" };

      const ticketsDir = workspaceContext.getProjectPaths().ticketsDir;
      const ticketDir = path.join(ticketsDir, params.ticketId);
      fs.mkdirSync(ticketDir, { recursive: true });

      if (params.progress) {
        ticketService.addComment(params.ticketId, params.agentId || "worker", params.agentName || "Worker", params.progress);
      }

      if (params.planification) {
        fs.writeFileSync(path.join(ticketDir, "plan.md"), params.planification, "utf8");
      }

      if (params.filesChanged && params.filesChanged.length > 0) {
        const existingFiles = [];
        try { existingFiles.push(...JSON.parse(fs.readFileSync(path.join(ticketDir, "files-changed.json"), "utf8"))); } catch {}
        const merged = [...new Set([...existingFiles, ...params.filesChanged])];
        fs.writeFileSync(path.join(ticketDir, "files-changed.json"), JSON.stringify(merged, null, 2), "utf8");
      }

      if (params.resultSummary) {
        fs.writeFileSync(path.join(ticketDir, "result.md"), params.resultSummary, "utf8");
      }

      if (params.reviewPhase) {
        ticketService.updateReviewPhase(params.ticketId, params.reviewPhase, params.agentId || "reviewer");
      }

      if (params.status) {
        if (params.status === "done" && params.resultSummary) {
          return ticketService.completeTicket(params.ticketId, params.resultSummary, params.agentId || "worker");
        } else {
          return ticketService.updateStatus(params.ticketId, params.status, params.agentId || "worker");
        }
      }

      ticket.updatedAt = new Date().toISOString();
      ticketStore.saveTicket(ticket);
      return { ok: true, ticketId: params.ticketId };
    }
    case "sprint_list": {
      return _ticketService().listSprints(params);
    }
    case "sprint_board": {
      return _ticketService().getSprintBoard(params.sprintId);
    }
    case "sprint_create": {
      return _ticketService().createSprint(params);
    }
    case "sprint_start": {
      return _ticketService().startSprint(params.sprintId);
    }
    case "sprint_end": {
      return _ticketService().endSprint(params.sprintId);
    }

    // --- Teams ---
    case "list_teams": {
      return require("@zana/work").teams.store.listTeams();
    }
    case "get_team": {
      const team = require("@zana/work").teams.store.getTeam(params.teamId);
      if (!team) return { error: `team not found: ${params.teamId}` };
      return team;
    }
    case "start_team": {
      const teamMod = require("@zana/work").teams.manager;
      const cwd = params.cwd || (getWorkspaceFn ? getWorkspaceFn() : process.env.HOME);
      return teamMod.startTeam(params.teamId, { prompt: params.prompt, cwd, headless: true });
    }
    case "stop_team": {
      return require("@zana/work").teams.manager.stopTeam(params.teamId);
    }
    case "team_status": {
      const status = require("@zana/work").teams.manager.getTeamStatus(params.teamId);
      if (!status) return { error: `team not running: ${params.teamId}` };
      return status;
    }
    case "list_running_teams": {
      return require("@zana/work").teams.manager.listRunningTeams();
    }

    // --- Artifacts ---
    case "artifact_create": {
      return _artifactStore().createArtifact(params);
    }
    case "artifact_list": {
      return _artifactStore().listArtifacts(params);
    }
    case "artifact_read": {
      const artifact = _artifactStore().getArtifact(params.artifactId);
      if (!artifact) return { error: `artifact not found: ${params.artifactId}` };
      return artifact;
    }
    case "artifact_update": {
      const { artifactId, ...fields } = params;
      const updated = _artifactStore().updateArtifact(artifactId, fields);
      if (!updated) return { error: `artifact not found: ${artifactId}` };
      return updated;
    }
    case "artifact_delete": {
      return { ok: _artifactStore().deleteArtifact(params.artifactId) };
    }

    // --- Scheduler ---
    case "schedule_create": {
      return _schedulerService().createSchedule(params);
    }
    case "schedule_list": {
      return _schedulerService().listSchedules();
    }
    case "schedule_get": {
      const schedulerService = _schedulerService();
      const schedule = schedulerService.getSchedule(params.scheduleId);
      const history = schedulerService.getRunHistory(params.scheduleId);
      return { schedule, history };
    }
    case "schedule_update": {
      const { id, ...fields } = params;
      return _schedulerService().updateSchedule(id, fields);
    }
    case "schedule_delete": {
      return { ok: _schedulerService().deleteSchedule(params.id) };
    }
    case "schedule_enable": {
      return _schedulerService().enableSchedule(params.id);
    }
    case "schedule_disable": {
      return _schedulerService().disableSchedule(params.id);
    }
    case "schedule_trigger": {
      return _schedulerService().triggerSchedule(params.id);
    }

    // --- Event Bus ---
    case "event_emit": {
      const eventBusService = require("../events/service");
      eventBusService.emit(params.type, params.payload, params.tags);
      return { ok: true };
    }
    case "event_query": {
      const eventBusService = require("../events/service");
      const filter = {};
      if (params.types) filter.types = params.types;
      if (params.source) filter.source = params.source;
      if (params.since) filter.since = params.since;
      return eventBusService.query(filter, params.limit || 50);
    }

    // --- Checkpoint ---
    case "checkpoint_save": {
      const cp = _checkpointStore().save(params);
      return { ok: true, checkpointId: cp.id };
    }
    case "checkpoint_list": {
      return _checkpointStore().list(params);
    }
    case "checkpoint_get": {
      const cp = _checkpointStore().load(params.checkpointId);
      if (!cp) return { error: "checkpoint not found" };
      return cp;
    }
    case "checkpoint_resume": {
      return await _checkpointResume().resume(params.checkpointId, { spawnHeadlessAgent, getAgent }, profileStore);
    }

    // --- Swarm P2P ---
    case "discover_agents": {
      const localAgents = listAgents();
      const subDaemonPorts = swarmSpawner.getSubDaemonPorts();
      const all = await swarmRouter.refreshRoutingTable(localAgents, subDaemonPorts);
      if (params.query) {
        return swarmRouter.discoverAgents(params.query);
      }
      return all;
    }
    case "ask_agent": {
      const msg = {
        fromAgentId: params.fromAgentId || params.fromTerminalId || "unknown",
        fromDaemonId: process.env.ZANA_ID || "local",
        fromAgentName: params.fromAgentName || "Agent",
        toAgentId: params.toAgentId,
        type: "question",
        body: params.question,
        replyTo: params.replyTo || undefined,
      };
      const localAgents = listAgents();
      const subDaemonPorts = swarmSpawner.getSubDaemonPorts();
      return await swarmRouter.routeMessage(msg, localAgents, subDaemonPorts);
    }
    case "check_inbox": {
      const agentId = params.agentId || params.terminalId;
      return swarmRouter.drainInbox(agentId);
    }

    // --- Typed messaging + channels ---
    case "send_message": {
      const msg = {
        id: swarmRouter.generateMessageId(),
        sentAt: Date.now(),
        fromAgentId: params.fromAgentId,
        fromDaemonId: process.env.ZANA_ID || "local",
        fromAgentName: params.fromAgentName || "Agent",
        toAgentId: params.toAgentId,
        type: params.type,
        payload: params.payload,
        priority: params.priority || "normal",
        replyTo: params.replyTo || undefined,
        requiresAck: params.requiresAck || false,
      };
      if (msg.requiresAck) swarmRouter.requestAck(msg.id);
      const subDaemonPorts = swarmSpawner.listSubDaemons()
        .filter((h) => h.status === "running" && h.port)
        .map((h) => h.port);
      const result = await swarmRouter.routeMessage(msg, listAgents(), subDaemonPorts);
      return { ...result, messageId: msg.id };
    }
    case "publish_channel": {
      const msg = {
        fromAgentId: params.fromAgentId,
        fromDaemonId: process.env.ZANA_ID || "local",
        fromAgentName: params.fromAgentName || "Agent",
        type: params.type,
        payload: params.payload,
      };
      return swarmRouter.publishToChannel(params.channel, msg);
    }
    case "subscribe_channel": {
      return swarmRouter.subscribeChannel(params.channel, params.agentId);
    }
    case "list_channels": {
      return swarmRouter.listChannels();
    }
    case "channel_history": {
      return swarmRouter.getChannelHistory(params.channel, { limit: params.limit });
    }
    case "send_ack": {
      return swarmRouter.sendAck(params.messageId, params.agentId, params.status, params.response);
    }

    // --- Swarm (multi-daemon coordination) ---
    case "swarm_spawn": {
      const masterPort = process.env.ZANA_HOOK_PORT || "47400";
      const result = swarmSpawner.spawnSubDaemon({
        teamId: params.teamId,
        workspace: params.workspace || getWorkspaceFn(),
        prompt: params.prompt,
        masterPort,
        masterDaemonId: process.env.ZANA_ID || "master",
      });
      return result;
    }
    case "swarm_list": {
      return swarmSpawner.listSubDaemons();
    }
    case "swarm_instruct": {
      return await swarmSpawner.instructSubDaemon(params.daemonId, params.message);
    }
    case "swarm_stop": {
      return swarmSpawner.stopSubDaemon(params.daemonId);
    }
    case "swarm_broadcast": {
      const daemons = swarmSpawner.listSubDaemons().filter((h) => h.status === "running");
      const results = [];
      for (const h of daemons) {
        const r = await swarmSpawner.instructSubDaemon(h.daemonId || h.daemonId, params.message);
        results.push({ daemonId: h.daemonId || h.daemonId, ...r });
      }
      return { ok: true, results };
    }
    case "swarm_poll_events": {
      return swarmEvents.pending(params.since || 0);
    }

    case "spawn_oneshot": {
      const { spawnOneShot } = require("./spawner");
      const { profileId, prompt } = params;
      const profile = profileStore.getProfile(profileId);
      if (!profile) return { error: `profile not found: ${profileId}` };
      const cwd = getWorkspaceFn ? getWorkspaceFn() : process.env.HOME;
      const result = await spawnOneShot(profile, prompt, { cwd, timeout: params.timeout });
      return { output: result.output, exitCode: result.exitCode };
    }

    default:
      return { error: `unknown action: ${action}` };
  }
}

