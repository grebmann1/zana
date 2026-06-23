import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import * as sseBroadcaster from "./sse-broadcaster";
import { lazyRequire } from "@zana-ai/contracts";
function _core() { return require("@zana-ai/core"); }
type ConnectionRegistry = typeof import("@zana-ai/core/dist/src/daemon/connection-registry");
const connectionRegistry = lazyRequire<ConnectionRegistry>(
  () => require("@zana-ai/core").daemon.connectionRegistry
);
import * as healthMonitor from "./health-monitor";
type TerminalRelay = typeof import("@zana-ai/core/dist/src/agents/terminal-relay");
const terminalRelay = lazyRequire<TerminalRelay>(
  () => require("@zana-ai/core").agents.terminalRelay
);
import * as authMiddleware from "./auth-middleware";

let server = null;
let daemonInstance = null;

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
  });
}

function json(res, data, status = 200, req = null) {
  const headers = { "Content-Type": "application/json" };
  const origin = req && authMiddleware.getCorsOrigin(req);
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function getDaemon() {
  return daemonInstance;
}

let settingsQueue: Promise<any> = Promise.resolve();
function settingsWriteQueue<T>(fn: () => T): Promise<T | { __error: string; __detail: string }> {
  const SettingsWriteError = require("@zana-ai/extras").settings.store.SettingsWriteError;
  const next = settingsQueue.then(() => {
    try {
      return fn();
    } catch (err) {
      const code = err instanceof SettingsWriteError ? err.code : "internal";
      return { __error: code, __detail: err && err.message ? err.message : String(err) };
    }
  });
  settingsQueue = next.catch(() => {});
  return next;
}

async function handleRequest(req, res) {
  if (!authMiddleware.authenticate(req)) {
    json(res, { error: "unauthorized" }, 401);
    return;
  }

  if (req.method === "OPTIONS") {
    const origin = authMiddleware.getCorsOrigin(req);
    const headers = {
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    };
    if (origin) headers["Access-Control-Allow-Origin"] = origin;
    res.writeHead(204, headers);
    res.end();
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  const method = req.method;

  const daemon = getDaemon();
  if (!daemon && pathname !== "/health") {
    json(res, { error: "daemon not ready" }, 503);
    return;
  }

  // --- Health ---
  if (method === "GET" && pathname === "/health") {
    const status = healthMonitor.getStatus(daemon ? () => daemon.agentManager.listAgents() : undefined);
    json(res, {
      ...status,
      daemonId: daemon?.daemonId || null,
      sseClients: sseBroadcaster.getClientCount(),
      connections: connectionRegistry.getCount(),
    });
    return;
  }

  // --- Status (detailed) ---
  if (method === "GET" && pathname === "/status") {
    const agents = daemon.agentManager.listAgents();
    const running = daemon.teamManager ? daemon.teamManager.listRunningTeams() : [];
    json(res, {
      daemonId: daemon.daemonId,
      workspace: daemon.workspace,
      uptime: process.uptime(),
      agents: agents.map((a) => ({ id: a.id, profile: a.profileName, state: a.state, mode: a.mode })),
      teams: running,
      connections: connectionRegistry.list(),
      sseClients: sseBroadcaster.getClientCount(),
    });
    return;
  }

  // --- Events (history query) ---
  if (method === "GET" && pathname === "/events") {
    const eventBusService = _core().events.service;
    const filter = {};
    const typesParam = url.searchParams.get("types");
    if (typesParam) filter.types = typesParam.split(",");
    const sinceParam = url.searchParams.get("since");
    if (sinceParam) filter.since = isNaN(Number(sinceParam)) ? new Date(sinceParam).getTime() : Number(sinceParam);
    const sourceParam = url.searchParams.get("source");
    if (sourceParam) filter.source = sourceParam;
    const tagsParam = url.searchParams.get("tags");
    if (tagsParam) filter.tags = tagsParam.split(",");
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    json(res, eventBusService.query(filter, limit));
    return;
  }

  // --- SSE Events Stream ---
  if (method === "GET" && pathname === "/events/stream") {
    const filterParam = url.searchParams.get("types");
    const filterTypes = filterParam ? filterParam.split(",") : null;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ daemonId: daemon.daemonId })}\n\n`);
    sseBroadcaster.addClient(res, filterTypes);
    return;
  }

  // --- Agents ---
  if (method === "GET" && pathname === "/agents") {
    json(res, daemon.agentManager.listAgents());
    return;
  }
  if (method === "POST" && pathname === "/agents") {
    const body = (await readBody(req)) as {
      profileId?: string; prompt?: string; cwd?: string; projectId?: string;
    };
    const profile = daemon.profileStore.getProfile(body.profileId);
    if (!profile) { json(res, { error: "profile not found" }, 404); return; }
    // Shared confinement with the in-process dispatch path (core agents.spawnCwd):
    // realpath-resolve + confine to the workspace (or a registered projectId),
    // closing the symlink / `../` escapes a plain string-prefix check missed.
    const cwdResult = _core().agents.spawnCwd.resolveConfinedCwd({
      cwd: body.cwd,
      projectId: body.projectId,
      workspace: daemon.workspace,
    });
    if ("error" in cwdResult) { json(res, { error: cwdResult.error }, 403); return; }
    const result = daemon.agentManager.spawnHeadlessAgent(profile, {
      prompt: body.prompt,
      cwd: cwdResult.cwd,
    });
    json(res, result, 201);
    return;
  }
  const agentMatch = pathname.match(/^\/agents\/([^/]+)$/);
  if (agentMatch) {
    const agentId = agentMatch[1];
    if (method === "GET") {
      const agents = daemon.agentManager.listAgents();
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) { json(res, { error: "not found" }, 404); return; }
      json(res, agent);
      return;
    }
    if (method === "DELETE") {
      const ok = daemon.agentManager.killAgent(agentId);
      json(res, { ok });
      return;
    }
  }
  const agentResultMatch = pathname.match(/^\/agents\/([^/]+)\/result$/);
  if (method === "GET" && agentResultMatch) {
    const result = await daemon.agentManager.handleOrchestratorCommand(
      { action: "agent_result", agentId: agentResultMatch[1] },
      () => daemon.workspace
    );
    json(res, result);
    return;
  }

  // --- Profiles ---
  if (method === "GET" && pathname === "/profiles") {
    json(res, daemon.profileStore.listProfiles().map((p) => ({
      id: p.id, name: p.displayName, icon: p.icon, category: p.category, description: p.description,
    })));
    return;
  }
  const profileMatch = pathname.match(/^\/profiles\/([^/]+)$/);
  if (profileMatch) {
    if (method === "GET") {
      const p = daemon.profileStore.getProfile(profileMatch[1]);
      if (!p) { json(res, { error: "not found" }, 404); return; }
      json(res, p);
      return;
    }
    if (method === "PUT") {
      const body = await readBody(req);
      body.id = profileMatch[1];
      const saved = daemon.profileStore.saveProfile(body);
      json(res, saved);
      return;
    }
    if (method === "DELETE") {
      const ok = daemon.profileStore.deleteProfile(profileMatch[1]);
      json(res, { ok });
      return;
    }
  }
  if (method === "POST" && pathname === "/profiles") {
    const body = await readBody(req);
    const saved = daemon.profileStore.saveProfile(body);
    json(res, saved, 201);
    return;
  }

  // --- Teams ---
  if (method === "GET" && pathname === "/teams") {
    json(res, daemon.teamStore.listTeams());
    return;
  }
  const teamMatch = pathname.match(/^\/teams\/([^/]+)$/);
  if (teamMatch) {
    if (method === "GET") {
      const t = daemon.teamStore.getTeam(teamMatch[1]);
      if (!t) { json(res, { error: "not found" }, 404); return; }
      json(res, t);
      return;
    }
    if (method === "PUT") {
      const body = await readBody(req);
      body.id = teamMatch[1];
      daemon.teamStore.saveTeam(body);
      json(res, body);
      return;
    }
    if (method === "DELETE") {
      daemon.teamStore.deleteTeam(teamMatch[1]);
      json(res, { ok: true });
      return;
    }
  }
  if (method === "POST" && pathname === "/teams") {
    const body = await readBody(req);
    daemon.teamStore.saveTeam(body);
    json(res, body, 201);
    return;
  }
  const teamStartMatch = pathname.match(/^\/teams\/([^/]+)\/start$/);
  if (method === "POST" && teamStartMatch) {
    const body = await readBody(req);
    // Hard load gate — same one applied at the orchestrator-command boundary.
    // We refuse a melted box outright rather than spawn an orchestrator that
    // burns turns retrying spawn_agent forever (issue #a2a8f209).
    const { checkSystemResources } = require("@zana-ai/core").agents.manager;
    const hardError = checkSystemResources?.("hard");
    if (hardError) {
      json(res, { ok: false, error: `cannot start team: ${hardError}` });
      return;
    }
    const result = await daemon.teamManager.startTeam(teamStartMatch[1], {
      prompt: body.prompt, cwd: body.cwd || daemon.workspace, headless: true,
    });
    json(res, result);
    return;
  }
  const teamStopMatch = pathname.match(/^\/teams\/([^/]+)\/stop$/);
  if (method === "POST" && teamStopMatch) {
    const result = daemon.teamManager.stopTeam(teamStopMatch[1]);
    json(res, result);
    return;
  }

  // --- Tickets ---
  if (method === "GET" && pathname === "/tickets/rules") {
    const watcher = require("@zana-ai/work").tickets.watcher;
    json(res, {
      rules: watcher.getRules(),
      warnings: watcher.getRuleWarnings ? watcher.getRuleWarnings() : [],
    });
    return;
  }
  if (method === "GET" && pathname === "/tickets") {
    const ticketService = require("@zana-ai/work").tickets.service;
    const status = url.searchParams.get("status");
    const label = url.searchParams.get("label");
    json(res, ticketService.listTickets({ status, label }));
    return;
  }
  if (method === "POST" && pathname === "/tickets") {
    const body = await readBody(req);
    const result = await daemon.agentManager.handleOrchestratorCommand(
      { action: "ticket_create", ...body, createdBy: body.createdBy || "api" },
      () => daemon.workspace
    );
    json(res, result, 201);
    return;
  }
  const ticketMatch = pathname.match(/^\/tickets\/([^/]+)$/);
  if (ticketMatch) {
    const ticketService = require("@zana-ai/work").tickets.service;
    if (method === "GET") {
      const t = ticketService.getTicket(ticketMatch[1]);
      if (!t) { json(res, { error: "not found" }, 404); return; }
      json(res, t);
      return;
    }
    if (method === "PUT") {
      const body = await readBody(req);
      body.ticketId = ticketMatch[1];
      const result = await daemon.agentManager.handleOrchestratorCommand(
        { action: "ticket_update", ...body },
        () => daemon.workspace
      );
      json(res, result);
      return;
    }
  }
  const ticketClaimMatch = pathname.match(/^\/tickets\/([^/]+)\/claim$/);
  if (method === "POST" && ticketClaimMatch) {
    const body = await readBody(req);
    const result = await daemon.agentManager.handleOrchestratorCommand(
      { action: "ticket_claim", ticketId: ticketClaimMatch[1], agentId: body.agentId || "api", agentName: body.agentName || "API" },
      () => daemon.workspace
    );
    json(res, result);
    return;
  }
  const ticketCompleteMatch = pathname.match(/^\/tickets\/([^/]+)\/complete$/);
  if (method === "POST" && ticketCompleteMatch) {
    const body = await readBody(req);
    const result = await daemon.agentManager.handleOrchestratorCommand(
      { action: "ticket_complete", ticketId: ticketCompleteMatch[1], resultSummary: body.resultSummary, completedBy: body.completedBy || "api" },
      () => daemon.workspace
    );
    json(res, result);
    return;
  }
  const ticketCommentMatch = pathname.match(/^\/tickets\/([^/]+)\/comment$/);
  if (method === "POST" && ticketCommentMatch) {
    const ticketService = require("@zana-ai/work").tickets.service;
    const body = await readBody(req);
    ticketService.addComment(ticketCommentMatch[1], body.agentId || "api", body.agentName || "API", body.content);
    json(res, { ok: true });
    return;
  }

  // --- Sprints ---
  if (method === "GET" && pathname === "/sprints") {
    const result = await daemon.agentManager.handleOrchestratorCommand({ action: "sprint_list" }, () => daemon.workspace);
    json(res, result);
    return;
  }
  if (method === "POST" && pathname === "/sprints") {
    const body = await readBody(req);
    const result = await daemon.agentManager.handleOrchestratorCommand(
      { action: "sprint_create", name: body.name, ticketIds: body.ticketIds },
      () => daemon.workspace
    );
    json(res, result, 201);
    return;
  }
  const sprintStartMatch = pathname.match(/^\/sprints\/([^/]+)\/start$/);
  if (method === "POST" && sprintStartMatch) {
    const result = await daemon.agentManager.handleOrchestratorCommand(
      { action: "sprint_start", sprintId: sprintStartMatch[1] },
      () => daemon.workspace
    );
    json(res, result);
    return;
  }
  const sprintEndMatch = pathname.match(/^\/sprints\/([^/]+)\/end$/);
  if (method === "POST" && sprintEndMatch) {
    const result = await daemon.agentManager.handleOrchestratorCommand(
      { action: "sprint_end", sprintId: sprintEndMatch[1] },
      () => daemon.workspace
    );
    json(res, result);
    return;
  }

  // --- Artifacts ---
  if (method === "GET" && pathname === "/artifacts") {
    const result = await daemon.agentManager.handleOrchestratorCommand(
      { action: "artifact_list", type: url.searchParams.get("type"), tag: url.searchParams.get("tag") },
      () => daemon.workspace
    );
    json(res, result);
    return;
  }
  if (method === "POST" && pathname === "/artifacts") {
    const body = await readBody(req);
    const result = await daemon.agentManager.handleOrchestratorCommand(
      { action: "artifact_create", ...body, createdBy: body.createdBy || "api" },
      () => daemon.workspace
    );
    json(res, result, 201);
    return;
  }
  const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)$/);
  if (method === "GET" && artifactMatch) {
    const result = await daemon.agentManager.handleOrchestratorCommand(
      { action: "artifact_read", artifactId: artifactMatch[1] },
      () => daemon.workspace
    );
    json(res, result);
    return;
  }

  // --- Skills ---
  if (method === "GET" && pathname === "/skills") {
    json(res, daemon.skillStore.listSkills());
    return;
  }
  if (method === "POST" && pathname === "/skills") {
    const body = await readBody(req);
    const saved = daemon.skillStore.saveSkill(body);
    json(res, saved, 201);
    return;
  }
  const skillMatch = pathname.match(/^\/skills\/([^/]+)$/);
  if (skillMatch) {
    if (method === "GET") {
      const s = daemon.skillStore.getSkill(skillMatch[1]);
      if (!s) { json(res, { error: "not found" }, 404); return; }
      json(res, s);
      return;
    }
    if (method === "DELETE") {
      const ok = daemon.skillStore.deleteSkill(skillMatch[1]);
      json(res, { ok });
      return;
    }
  }

  // --- Settings ---
  if (method === "GET" && pathname === "/settings") {
    const settingsStore = require("@zana-ai/extras").settings.store;
    json(res, settingsStore.read());
    return;
  }
  if (method === "POST" && pathname === "/settings") {
    const settingsStore = require("@zana-ai/extras").settings.store;
    const body = await readBody(req);
    const validationErr = settingsStore.validate(body);
    if (validationErr) {
      json(res, { error: "validation_failed", detail: validationErr }, 400);
      return;
    }
    // Serialize POSTs through one queue so concurrent in-process requests can't
    // race the read-modify-write. Atomic rename in store.write() prevents torn
    // reads. Cross-daemon read-modify-write CAN still lose updates if two
    // daemons on the same host POST simultaneously; accepted because /settings
    // is a low-frequency admin surface.
    const merged = await settingsWriteQueue(() => {
      const next = settingsStore.deepMerge(settingsStore.read(), body);
      settingsStore.write(next);
      return next;
    });
    if (merged && merged.__error) {
      const status = merged.__error === "validation_failed" ? 400 : 500;
      json(res, { error: merged.__error, detail: merged.__detail }, status);
      return;
    }
    json(res, merged);
    return;
  }

  // --- Workspace ---
  if (method === "GET" && pathname === "/workspace") {
    const workspaceContext = _core().project.workspaceContext;
    json(res, {
      root: workspaceContext.getWorkspaceRoot(),
      paths: workspaceContext.getProjectPaths(),
      initialized: workspaceContext.isInitialized(),
    });
    return;
  }

  // --- Orchestrator (legacy passthrough) ---
  if (method === "POST" && pathname === "/orchestrator") {
    const body = await readBody(req);
    try {
      const result = await daemon.agentManager.handleOrchestratorCommand(body, () => daemon.workspace);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  // --- Swarm ---
  if (method === "GET" && pathname === "/swarm/agents") {
    const agents = daemon.agentManager.listAgents()
      .filter((a) => a.state !== "terminated")
      .map((a) => ({ id: a.id, terminalId: a.terminalId, profileName: a.profileName, state: a.state, mode: a.mode }));
    json(res, agents);
    return;
  }
  if (method === "GET" && pathname === "/swarm/inbox") {
    const agentId = url.searchParams.get("agentId");
    if (!agentId) { json(res, { error: "agentId required" }, 400); return; }
    if (!AGENT_ID_PATTERN.test(agentId)) { json(res, { error: "invalid agentId" }, 400); return; }
    const drain = url.searchParams.get("drain") === "true";
    const messages = drain
      ? daemon.swarmRouter.drainInbox(agentId)
      : daemon.swarmRouter.peekInbox(agentId);
    json(res, messages);
    return;
  }
  if (method === "POST" && pathname === "/swarm/inbox") {
    const body = await readBody(req);
    if (body.toAgentId) {
      if (!AGENT_ID_PATTERN.test(body.toAgentId)) {
        json(res, { ok: false, error: "invalid toAgentId" }, 400);
        return;
      }
      daemon.swarmRouter.deliverLocal(body.toAgentId, body);
    }
    json(res, { ok: true });
    return;
  }
  if (method === "POST" && pathname === "/swarm/instruct") {
    const body = await readBody(req);
    const agents = daemon.agentManager.listAgents();
    const lead = agents.find((a) => a.state === "active" && a.mode === "headless");
    if (!lead) { json(res, { ok: false, error: "no active agent" }, 404); return; }
    const payload = { type: "user", message: { role: "user", content: [{ type: "text", text: body.message }] } };
    const written = daemon.agentManager.writeToAgent(lead.id, payload);
    json(res, { ok: written, agentId: lead.id });
    return;
  }
  if (method === "POST" && pathname === "/swarm/events") {
    const body = await readBody(req);
    daemon.swarmEvents.pushEvent(body);
    json(res, { ok: true });
    return;
  }

  // --- Terminals ---
  if (method === "GET" && pathname === "/terminals") {
    const ptyHost = _core().agents.ptyHost;
    json(res, ptyHost.listTerminals());
    return;
  }

  // --- Task Router (Intelligence) ---
  if (method === "POST" && pathname === "/route") {
    const body = await readBody(req);
    const results = daemon.taskRouter.route(body);
    json(res, results);
    return;
  }
  if (method === "GET" && pathname === "/route/stats") {
    json(res, daemon.taskRouter.getStats());
    return;
  }
  if (method === "POST" && pathname === "/route/outcome") {
    const body = await readBody(req);
    daemon.taskRouter.recordOutcome(body);
    json(res, { ok: true });
    return;
  }

  // --- Vector Memory ---
  if (method === "POST" && pathname === "/memory") {
    const body = await readBody(req);
    const result = daemon.vectorMemory.store(body);
    json(res, result, 201);
    return;
  }
  if (method === "GET" && pathname === "/memory") {
    const query = url.searchParams.get("q");
    if (!query) { json(res, daemon.vectorMemory.stats()); return; }
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);
    const tier = url.searchParams.get("tier") || undefined;
    const results = daemon.vectorMemory.search(query, { limit, tier });
    json(res, results);
    return;
  }
  const memoryMatch = pathname.match(/^\/memory\/([^/]+)$/);
  if (memoryMatch) {
    if (method === "GET") {
      const entry = daemon.vectorMemory.get(memoryMatch[1]);
      if (!entry) { json(res, { error: "not found" }, 404); return; }
      json(res, entry);
      return;
    }
    if (method === "DELETE") {
      const ok = daemon.vectorMemory.delete(memoryMatch[1]);
      json(res, { ok });
      return;
    }
  }
  if (method === "POST" && pathname === "/memory/maintain") {
    const result = daemon.vectorMemory.maintain();
    json(res, result);
    return;
  }

  // --- GOAP Planner ---
  if (method === "POST" && pathname === "/plans") {
    const body = await readBody(req);
    const plan = daemon.goapPlanner.createPlan(body.goal, body.options);
    json(res, plan, 201);
    return;
  }
  if (method === "GET" && pathname === "/plans") {
    json(res, daemon.goapPlanner.listPlans());
    return;
  }
  const planMatch = pathname.match(/^\/plans\/([^/]+)$/);
  if (planMatch) {
    if (method === "GET") {
      const status = daemon.goapPlanner.getPlanStatus(planMatch[1]);
      if (!status) { json(res, { error: "not found" }, 404); return; }
      json(res, status);
      return;
    }
    if (method === "DELETE") {
      const ok = daemon.goapPlanner.cancelPlan(planMatch[1]);
      json(res, { ok });
      return;
    }
  }
  const planExecMatch = pathname.match(/^\/plans\/([^/]+)\/execute$/);
  if (method === "POST" && planExecMatch) {
    daemon.goapPlanner.executePlan(planExecMatch[1]).then((result) => {
      _core().events.service.emit("plan:execution-done", { planId: planExecMatch[1], ...result });
    });
    json(res, { ok: true, message: "execution started" });
    return;
  }

  // --- Background Workers ---
  if (method === "GET" && pathname === "/workers") {
    json(res, daemon.backgroundWorkers.list());
    return;
  }
  const workerMatch = pathname.match(/^\/workers\/([^/]+)$/);
  if (workerMatch) {
    if (method === "GET") {
      json(res, daemon.backgroundWorkers.history(workerMatch[1]));
      return;
    }
  }
  const workerEnableMatch = pathname.match(/^\/workers\/([^/]+)\/enable$/);
  if (method === "POST" && workerEnableMatch) {
    const ok = daemon.backgroundWorkers.enable(workerEnableMatch[1]);
    json(res, { ok });
    return;
  }
  const workerDisableMatch = pathname.match(/^\/workers\/([^/]+)\/disable$/);
  if (method === "POST" && workerDisableMatch) {
    const ok = daemon.backgroundWorkers.disable(workerDisableMatch[1]);
    json(res, { ok });
    return;
  }
  const workerTriggerMatch = pathname.match(/^\/workers\/([^/]+)\/trigger$/);
  if (method === "POST" && workerTriggerMatch) {
    try {
      const result = await daemon.backgroundWorkers.trigger(workerTriggerMatch[1]);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
    return;
  }

  // --- Modules ---
  if (method === "GET" && pathname === "/api/modules") {
    json(res, daemon.moduleLoader.listModules());
    return;
  }
  const moduleMatch = pathname.match(/^\/api\/modules\/([^/]+)$/);
  if (moduleMatch) {
    if (method === "GET") {
      const modules = daemon.moduleLoader.listModules();
      const mod = modules.find((m) => m.id === moduleMatch[1]);
      if (!mod) { json(res, { error: "not found" }, 404); return; }
      json(res, mod);
      return;
    }
    if (method === "PATCH") {
      const body = await readBody(req);
      if (body.enabled === true) {
        daemon.moduleLoader.enableModule(moduleMatch[1]);
      } else if (body.enabled === false) {
        daemon.moduleLoader.disableModule(moduleMatch[1]);
      }
      const modules = daemon.moduleLoader.listModules();
      const mod = modules.find((m) => m.id === moduleMatch[1]);
      json(res, mod || { id: moduleMatch[1], enabled: body.enabled });
      return;
    }
  }
  const moduleConfigMatch = pathname.match(/^\/api\/modules\/([^/]+)\/config$/);
  if (moduleConfigMatch) {
    const workspaceContext = _core().project.workspaceContext;
    const configPath = workspaceContext.getProjectPaths().configPath;
    if (method === "GET") {
      let config = {};
      try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}
      json(res, config[moduleConfigMatch[1]] || {});
      return;
    }
    if (method === "PUT") {
      const body = await readBody(req);
      let config = {};
      try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}
      config[moduleConfigMatch[1]] = body;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      json(res, body);
      return;
    }
  }

  // --- Module route delegation ---
  const moduleRouteMatch = pathname.match(/^\/m\/([^/]+)\/(.*)$/);
  if (moduleRouteMatch) {
    const handled = await daemon.moduleLoader.handleRoute(moduleRouteMatch[1], "/" + moduleRouteMatch[2], req, res);
    if (handled) return;
    json(res, { error: "module route not found" }, 404);
    return;
  }

  // --- Schedules ---
  if (method === "GET" && pathname === "/api/schedules") {
    const schedulerService = require("@zana-ai/work").scheduling.service;
    json(res, schedulerService.listSchedules());
    return;
  }
  if (method === "POST" && pathname === "/api/schedules") {
    const schedulerService = require("@zana-ai/work").scheduling.service;
    const body = await readBody(req);
    const schedule = schedulerService.createSchedule(body);
    json(res, schedule, 201);
    return;
  }
  const scheduleMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleMatch) {
    const schedulerService = require("@zana-ai/work").scheduling.service;
    const id = scheduleMatch[1];
    if (method === "GET") {
      const s = schedulerService.getSchedule(id);
      if (!s) { json(res, { error: "not found" }, 404); return; }
      json(res, s);
      return;
    }
    if (method === "PUT") {
      const body = await readBody(req);
      const result = schedulerService.updateSchedule(id, body);
      if (result.error) { json(res, result, 404); return; }
      json(res, result);
      return;
    }
    if (method === "DELETE") {
      const ok = schedulerService.deleteSchedule(id);
      json(res, { ok });
      return;
    }
  }
  const scheduleEnableMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/enable$/);
  if (method === "POST" && scheduleEnableMatch) {
    const schedulerService = require("@zana-ai/work").scheduling.service;
    const result = schedulerService.enableSchedule(scheduleEnableMatch[1]);
    if (result.error) { json(res, result, 404); return; }
    json(res, result);
    return;
  }
  const scheduleDisableMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/disable$/);
  if (method === "POST" && scheduleDisableMatch) {
    const schedulerService = require("@zana-ai/work").scheduling.service;
    const result = schedulerService.disableSchedule(scheduleDisableMatch[1]);
    if (result.error) { json(res, result, 404); return; }
    json(res, result);
    return;
  }
  const scheduleTriggerMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/trigger$/);
  if (method === "POST" && scheduleTriggerMatch) {
    const schedulerService = require("@zana-ai/work").scheduling.service;
    const result = await schedulerService.triggerSchedule(scheduleTriggerMatch[1]);
    if (result.error) { json(res, result, 404); return; }
    json(res, result);
    return;
  }
  const scheduleHistoryMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/history$/);
  if (method === "GET" && scheduleHistoryMatch) {
    const schedulerStore = require("@zana-ai/work").scheduling.store;
    json(res, schedulerStore.getRunHistory(scheduleHistoryMatch[1]));
    return;
  }
  if (method === "POST" && pathname === "/api/schedules/reload") {
    const schedulerService = require("@zana-ai/work").scheduling.service;
    json(res, schedulerService.loadFromDisk());
    return;
  }

  // --- Checkpoints ---
  if (method === "GET" && pathname === "/api/checkpoints") {
    const checkpointStore = require("@zana-ai/work").runs.checkpoint.store;
    const filter = {};
    const teamId = url.searchParams.get("teamId");
    if (teamId) filter.teamId = teamId;
    const runId = url.searchParams.get("runId");
    if (runId) filter.runId = runId;
    const status = url.searchParams.get("status");
    if (status) filter.status = status;
    json(res, checkpointStore.list(filter));
    return;
  }
  if (method === "POST" && pathname === "/api/checkpoints") {
    const checkpointStore = require("@zana-ai/work").runs.checkpoint.store;
    const body = await readBody(req);
    const checkpoint = checkpointStore.save(body);
    json(res, checkpoint, 201);
    return;
  }
  const checkpointMatch = pathname.match(/^\/api\/checkpoints\/([^/]+)$/);
  if (checkpointMatch) {
    const checkpointStore = require("@zana-ai/work").runs.checkpoint.store;
    const id = checkpointMatch[1];
    if (method === "GET") {
      const cp = checkpointStore.load(id);
      if (!cp) { json(res, { error: "not found" }, 404); return; }
      json(res, cp);
      return;
    }
  }
  const checkpointResumeMatch = pathname.match(/^\/api\/checkpoints\/([^/]+)\/resume$/);
  if (method === "POST" && checkpointResumeMatch) {
    const checkpointResume = require("@zana-ai/work").runs.checkpoint.resume;
    const result = await checkpointResume.resume(
      checkpointResumeMatch[1],
      daemon.agentManager,
      daemon.profileStore
    );
    if (!result.ok) { json(res, result, result.error === "checkpoint not found" ? 404 : 400); return; }
    json(res, result);
    return;
  }

  // --- Workflows ---
  if (method === "POST" && pathname === "/api/workflows/run") {
    const workflowEngine = require("@zana-ai/work").scheduling.workflowEngine;
    const body = await readBody(req);
    if (!body.skill && !body.steps) { json(res, { error: "skill or steps required" }, 400); return; }
    const skill = body.skill || { id: body.id || "inline", name: body.name || "inline", steps: body.steps };
    const run = await workflowEngine.executeWorkflow(skill, body.triggerContext || {});
    if (run.error) { json(res, run, 400); return; }
    json(res, run, 201);
    return;
  }
  if (method === "GET" && pathname === "/api/workflows/runs") {
    const workflowEngine = require("@zana-ai/work").scheduling.workflowEngine;
    const filter = {};
    const status = url.searchParams.get("status");
    if (status) filter.status = status;
    json(res, workflowEngine.listRuns(filter));
    return;
  }
  const workflowRunMatch = pathname.match(/^\/api\/workflows\/runs\/([^/]+)$/);
  if (method === "GET" && workflowRunMatch) {
    const workflowEngine = require("@zana-ai/work").scheduling.workflowEngine;
    const run = workflowEngine.loadRun(workflowRunMatch[1]);
    if (!run) { json(res, { error: "not found" }, 404); return; }
    json(res, run);
    return;
  }

  // --- Autopilot Goals ---
  if (method === "GET" && pathname === "/api/autopilot/goals") {
    const autopilot = daemon.moduleLoader.getModule("autopilot");
    if (!autopilot || !autopilot.api) { json(res, { error: "autopilot module not available" }, 503); return; }
    const filter = {};
    const status = url.searchParams.get("status");
    if (status) filter.status = status;
    json(res, autopilot.api.listGoals(filter));
    return;
  }
  if (method === "POST" && pathname === "/api/autopilot/goals") {
    const autopilot = daemon.moduleLoader.getModule("autopilot");
    if (!autopilot || !autopilot.api) { json(res, { error: "autopilot module not available" }, 503); return; }
    const body = await readBody(req);
    const goal = autopilot.api.setGoal(body);
    json(res, goal, 201);
    return;
  }
  const autopilotGoalMatch = pathname.match(/^\/api\/autopilot\/goals\/([^/]+)$/);
  if (autopilotGoalMatch) {
    const autopilot = daemon.moduleLoader.getModule("autopilot");
    if (!autopilot || !autopilot.api) { json(res, { error: "autopilot module not available" }, 503); return; }
    const id = autopilotGoalMatch[1];
    if (method === "GET") {
      const goal = autopilot.api.getGoal(id);
      if (!goal) { json(res, { error: "not found" }, 404); return; }
      json(res, goal);
      return;
    }
    if (method === "DELETE") {
      const result = autopilot.api.cancelGoal(id);
      if (!result.ok) { json(res, result, 400); return; }
      json(res, result);
      return;
    }
  }

  // --- Shutdown ---
  if (method === "POST" && pathname === "/shutdown") {
    json(res, { ok: true });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
    return;
  }

  const pluginLoader = require("@zana-ai/extras").plugins.loader;
  if (pathname.startsWith("/x/") && pluginLoader.handlePluginRoute(pathname, req, res)) {
    return;
  }

  json(res, { error: "not found" }, 404);
}

export function start(daemon, port, options = {}) {
  daemonInstance = daemon;
  sseBroadcaster.init();
  if (options.token) {
    authMiddleware.init({ token: options.token });
  } else {
    authMiddleware.init();
  }

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      process.stderr.write(`[api-server] ${req.method} ${req.url}: ${err.message}\n`);
      try { json(res, { error: "internal error" }, 500); } catch {}
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (!authMiddleware.authenticate(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    terminalRelay.acceptWebSocket(req, socket, head);
  });

  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(`[api-server] listening on http://127.0.0.1:${port}\n`);
  });

  server.on("error", (err) => {
    process.stderr.write(`[api-server] failed to bind port ${port}: ${err.message}\n`);
  });

  return server;
}

export function stop() {
  if (server) { server.close(); server = null; }
}

