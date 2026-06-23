// Ticket-dispatch and orchestrator-command routing. The big switch that maps
// MCP/orchestrator action strings to lifecycle / team-runtime / work / swarm
// helpers. Extracted from agents/manager.ts.

import { lazyRequire } from "@zana-ai/contracts";
import * as profileStore from "./profile-store";
import {
  spawnHeadlessAgent,
  listAgents,
  getAgent,
  killAgent,
  checkSystemResources,
  recordSpawnOverload,
  clearSpawnOverloadStreak,
  getSpawnThrottleStreakLimit,
  getMaxConcurrentAgents,
} from "./lifecycle";
import * as teamRuntime from "./team-runtime";
import { resolveConfinedCwd } from "./spawn-cwd";

type SkillStoreModule = typeof import("@zana-ai/extras/dist/src/settings/skill-store");
const skillStore = lazyRequire<SkillStoreModule>(
  () => require("@zana-ai/extras").settings.skillStore
);
const swarmPkg = require("@zana-ai/swarm");
const swarmRouter = swarmPkg.router;
const swarmEvents = swarmPkg.events;
const swarmSpawner = swarmPkg.spawner;

// Lazy access to @zana-ai/work — single Proxy fronts the whole package; the
// require-cache + helper memo keep this cheap. Cycle is broken by deferring
// the require to first property access.
const work = lazyRequire<typeof import("@zana-ai/work")>("@zana-ai/work");
function _ticketService() { return work.tickets.service; }
function _ticketStore() { return work.tickets.store; }
function _schedulerService() { return work.scheduling.service; }
function _artifactStore() { return work.runs.artifacts; }

export async function handleOrchestratorCommand(payload: any, getWorkspaceFn: any) {
  // `action` is the routing command (e.g. "schedule_create"). A few tools —
  // schedule_create / schedule_update / scheduled mcp_tool calls — also carry a
  // *parameter* literally named `action` (the schedule's action object). Both
  // cannot share one key: a naive `{ action, ...params }` at the call site lets
  // the param clobber the command, so routing receives the object and falls
  // through to `unknown action: [object Object]`.
  //
  // Callers disambiguate by sending the routing command under the reserved
  // `_action` key, which takes precedence; the literal `action` then survives
  // untouched as a normal parameter. Legacy callers that send the command under
  // `action` (with no colliding param) keep working via the fallback.
  const { _action, ...rest } = payload;
  let action: string;
  let params: any;
  if (_action !== undefined) {
    action = _action;
    params = rest; // `rest.action`, if present, is a genuine parameter
  } else {
    action = rest.action;
    const { action: _routingKey, ...p } = rest;
    params = p;
  }

  switch (action) {
    case "spawn_agent": {
      const resilienceMod = require("../modules/loader").getModule?.("resilience");
      if (resilienceMod?.api?.isOpen?.("agent-spawn")) {
        return { error: "Circuit breaker open: too many recent spawn failures. Try again later." };
      }
      const { profileId, prompt, parentAgentId } = params;
      const resourceError = checkSystemResources();
      // (cwd confinement happens after the cheap guards below, right before spawn)
      if (resourceError) {
        const streak = recordSpawnOverload(parentAgentId);
        const limit = getSpawnThrottleStreakLimit();
        if (streak >= limit) {
          // Stop telling the orchestrator to retry — return a terminal-shaped
          // error and clear the streak so a future attempt can start fresh.
          clearSpawnOverloadStreak(parentAgentId);
          return {
            error: `persistently overloaded: spawn refused ${streak} consecutive times (${resourceError}). Stop spawning new agents.`,
            terminal: true,
          };
        }
        return { error: `system overloaded: ${resourceError}` };
      }
      clearSpawnOverloadStreak(parentAgentId);
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
      const cwdResult = resolveConfinedCwd({
        cwd: params.cwd,
        projectId: params.projectId,
        workspace: getWorkspaceFn ? getWorkspaceFn() : process.env.HOME,
      });
      if ("error" in cwdResult) return { error: cwdResult.error };
      const result = spawnHeadlessAgent(profile, { prompt, cwd: cwdResult.cwd, parentAgentId });
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
      const cwdResult = resolveConfinedCwd({
        cwd: params.cwd,
        projectId: params.projectId,
        workspace: getWorkspaceFn ? getWorkspaceFn() : process.env.HOME,
      });
      if ("error" in cwdResult) return { error: cwdResult.error };
      const guardrails = require("../guardrails/index");
      const result = await guardrails.spawnValidatedAgent(
        { spawnHeadlessAgent, getAgent },
        profile,
        { prompt, cwd: cwdResult.cwd, parentAgentId, maxRetries },
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
        // `lens` lets callers pick voters by concern (e.g. the council
        // auto-roster maps a question to relevant lenses). Coordination/util
        // profiles have no lens — that's how the council filters them out.
        lens: p.lens || null,
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
    case "ticket_claim_next": {
      return _ticketService().claimNextReady(params.agentId, params.agentName, params.profileId, {
        sprintId: params.sprintId,
      });
    }
    case "ticket_list_ready": {
      return _ticketService().listReadyTickets({ sprintId: params.sprintId });
    }
    case "ticket_update_status": {
      return _ticketService().updateStatus(params.ticketId, params.status, params.updatedBy);
    }
    case "ticket_comment": {
      return _ticketService().addComment(params.ticketId, params.authorId, params.authorName, params.body);
    }
    case "ticket_verdict": {
      return _ticketService().recordVerdict(
        params.ticketId, params.verdict, params.reason, params.reportedBy, params.profileLabel);
    }
    case "ticket_complete": {
      return _ticketService().completeTicket(params.ticketId, params.resultSummary, params.completedBy, params.evidence);
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
    case "ticket_timeline": {
      return _ticketService().getTicketTimeline(params.ticketId);
    }
    case "ticket_children": {
      return _ticketService().getChildren(params.ticketId);
    }
    case "ticket_request_human": {
      return _ticketService().requestHumanCheckpoint(
        params.ticketId, params.reason, params.requestedBy, params.kind);
    }
    case "ticket_resolve_human": {
      return _ticketService().resolveHumanCheckpoint(
        params.ticketId, params.resolution, params.resolvedBy, params.note);
    }
    case "ticket_update": {
      const ticketService = _ticketService();
      const ticketStore = _ticketStore();
      const fs = require("node:fs");
      const path = require("node:path");
      const workspaceContext = require("@zana-ai/contracts");

      const ticket = ticketService.getTicket(params.ticketId);
      if (!ticket) return { error: "ticket not found" };

      const ticketsDir = workspaceContext.getProjectPaths().ticketsDir;
      const ticketDir = path.join(ticketsDir, params.ticketId);
      fs.mkdirSync(ticketDir, { recursive: true });

      // Record where the implementation landed so the reviewer isn't blind to
      // work committed on a different branch/worktree than the checked-out HEAD.
      // Persisted on the ticket (workRef) and surfaced to reviewer prompts.
      if (params.workRef && typeof params.workRef === "object") {
        ticket.workRef = params.workRef;
        ticket.updatedAt = new Date().toISOString();
        ticketStore.saveTicket(ticket);
      }

      if (params.progress) {
        ticketService.addComment(params.ticketId, params.agentId || "worker", params.agentName || "Worker", params.progress);
      }

      if (params.planification) {
        fs.writeFileSync(path.join(ticketDir, "plan.md"), params.planification, "utf8");
      }

      if (params.filesChanged && params.filesChanged.length > 0) {
        const existingFiles: string[] = [];
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
      return teamRuntime.listTeams();
    }
    case "get_team": {
      return teamRuntime.getTeam(params.teamId);
    }
    case "start_team": {
      return teamRuntime.startTeam(params, getWorkspaceFn);
    }
    case "stop_team": {
      return teamRuntime.stopTeam(params.teamId);
    }
    case "team_status": {
      return teamRuntime.teamStatus(params.teamId);
    }
    case "list_running_teams": {
      return teamRuntime.listRunningTeams();
    }
    case "save_team": {
      return teamRuntime.saveTeam(params.team);
    }
    case "delete_team": {
      return teamRuntime.deleteTeam(params.teamId);
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
    case "schedule_reload": {
      return _schedulerService().loadFromDisk();
    }

    // --- Event Bus ---
    case "event_emit": {
      const eventBusService = require("../events/service");
      eventBusService.emit(params.type, params.payload, params.tags);
      return { ok: true };
    }
    case "event_query": {
      const eventBusService = require("../events/service");
      const filter: any = {};
      if (params.types) filter.types = params.types;
      if (params.source) filter.source = params.source;
      if (params.since) filter.since = params.since;
      return eventBusService.query(filter, params.limit || 50);
    }

    // --- Checkpoint ---
    case "checkpoint_save": {
      return teamRuntime.checkpointSave(params);
    }
    case "checkpoint_list": {
      return teamRuntime.checkpointList(params);
    }
    case "checkpoint_get": {
      return teamRuntime.checkpointGet(params.checkpointId);
    }
    case "checkpoint_resume": {
      return await teamRuntime.checkpointResume(params.checkpointId);
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
    case "resolve_agent_name": {
      // Look up an active agent by human-readable name. Returns agentId or null.
      // First exact-name match in the local agent registry; falls back to the
      // swarm-wide routing table for cross-daemon names.
      const name: string = params.name;
      if (!name) return null;
      const local = listAgents().find((a: any) => a.name === name);
      if (local?.id) return local.id;
      try {
        const subDaemonPorts = swarmSpawner.getSubDaemonPorts();
        const all = await swarmRouter.refreshRoutingTable(listAgents(), subDaemonPorts);
        const match = (all as any[]).find((a: any) => a.name === name);
        return match?.id || null;
      } catch {
        return null;
      }
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
        .filter((h: any) => h.status === "running" && h.port)
        .map((h: any) => h.port);
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
      const daemons = swarmSpawner.listSubDaemons().filter((h: any) => h.status === "running");
      const results = [];
      for (const h of daemons) {
        const r = await swarmSpawner.instructSubDaemon(h.daemonId, params.message);
        results.push({ daemonId: h.daemonId, ...r });
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
      const cwdResult = resolveConfinedCwd({
        cwd: params.cwd,
        projectId: params.projectId,
        workspace: getWorkspaceFn ? getWorkspaceFn() : process.env.HOME,
      });
      if ("error" in cwdResult) return { error: cwdResult.error };
      const result = await spawnOneShot(profile, prompt, { cwd: cwdResult.cwd, timeout: params.timeout });
      return { output: result.output, exitCode: result.exitCode };
    }

    default:
      return {
        error: `unknown action: ${typeof action === "string" ? action : JSON.stringify(action)}`,
      };
  }
}
