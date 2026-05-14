import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import * as sseBroadcaster from "./sse-broadcaster";
import * as connectionRegistry from "./connection-registry";
import * as healthMonitor from "./health-monitor";
import * as terminalRelay from "./terminal-relay";
import * as authMiddleware from "./auth-middleware";

let server = null;
let hiveInstance = null;

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

function getHive() {
  return hiveInstance;
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

  const hive = getHive();
  if (!hive && pathname !== "/health") {
    json(res, { error: "hive not ready" }, 503);
    return;
  }

  // --- Health ---
  if (method === "GET" && pathname === "/health") {
    const status = healthMonitor.getStatus(hive ? () => hive.agentManager.listAgents() : undefined);
    json(res, {
      ...status,
      hiveId: hive?.hiveId || null,
      sseClients: sseBroadcaster.getClientCount(),
      connections: connectionRegistry.getCount(),
    });
    return;
  }

  // --- Status (detailed) ---
  if (method === "GET" && pathname === "/status") {
    const agents = hive.agentManager.listAgents();
    const running = hive.teamManager ? hive.teamManager.listRunningTeams() : [];
    json(res, {
      hiveId: hive.hiveId,
      workspace: hive.workspace,
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
    const eventBusService = require("./event-bus-service");
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
    res.write(`event: connected\ndata: ${JSON.stringify({ hiveId: hive.hiveId })}\n\n`);
    sseBroadcaster.addClient(res, filterTypes);
    return;
  }

  // --- Agents ---
  if (method === "GET" && pathname === "/agents") {
    json(res, hive.agentManager.listAgents());
    return;
  }
  if (method === "POST" && pathname === "/agents") {
    const body = await readBody(req);
    const profile = hive.profileStore.getProfile(body.profileId);
    if (!profile) { json(res, { error: "profile not found" }, 404); return; }
    let cwd = body.cwd || hive.workspace;
    const resolved = path.resolve(cwd);
    if (!resolved.startsWith(path.resolve(hive.workspace))) {
      json(res, { error: "cwd must be within workspace" }, 403);
      return;
    }
    const result = hive.agentManager.spawnHeadlessAgent(profile, {
      prompt: body.prompt,
      cwd: resolved,
    });
    json(res, result, 201);
    return;
  }
  const agentMatch = pathname.match(/^\/agents\/([^/]+)$/);
  if (agentMatch) {
    const agentId = agentMatch[1];
    if (method === "GET") {
      const agents = hive.agentManager.listAgents();
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) { json(res, { error: "not found" }, 404); return; }
      json(res, agent);
      return;
    }
    if (method === "DELETE") {
      const ok = hive.agentManager.killAgent(agentId);
      json(res, { ok });
      return;
    }
  }
  const agentResultMatch = pathname.match(/^\/agents\/([^/]+)\/result$/);
  if (method === "GET" && agentResultMatch) {
    const result = await hive.agentManager.handleOrchestratorCommand(
      { action: "agent_result", agentId: agentResultMatch[1] },
      () => hive.workspace
    );
    json(res, result);
    return;
  }

  // --- Profiles ---
  if (method === "GET" && pathname === "/profiles") {
    json(res, hive.profileStore.listProfiles().map((p) => ({
      id: p.id, name: p.displayName, icon: p.icon, category: p.category, description: p.description,
    })));
    return;
  }
  const profileMatch = pathname.match(/^\/profiles\/([^/]+)$/);
  if (profileMatch) {
    if (method === "GET") {
      const p = hive.profileStore.getProfile(profileMatch[1]);
      if (!p) { json(res, { error: "not found" }, 404); return; }
      json(res, p);
      return;
    }
    if (method === "PUT") {
      const body = await readBody(req);
      body.id = profileMatch[1];
      const saved = hive.profileStore.saveProfile(body);
      json(res, saved);
      return;
    }
    if (method === "DELETE") {
      const ok = hive.profileStore.deleteProfile(profileMatch[1]);
      json(res, { ok });
      return;
    }
  }
  if (method === "POST" && pathname === "/profiles") {
    const body = await readBody(req);
    const saved = hive.profileStore.saveProfile(body);
    json(res, saved, 201);
    return;
  }

  // --- Teams ---
  if (method === "GET" && pathname === "/teams") {
    json(res, hive.teamStore.listTeams());
    return;
  }
  const teamMatch = pathname.match(/^\/teams\/([^/]+)$/);
  if (teamMatch) {
    if (method === "GET") {
      const t = hive.teamStore.getTeam(teamMatch[1]);
      if (!t) { json(res, { error: "not found" }, 404); return; }
      json(res, t);
      return;
    }
    if (method === "PUT") {
      const body = await readBody(req);
      body.id = teamMatch[1];
      hive.teamStore.saveTeam(body);
      json(res, body);
      return;
    }
    if (method === "DELETE") {
      hive.teamStore.deleteTeam(teamMatch[1]);
      json(res, { ok: true });
      return;
    }
  }
  if (method === "POST" && pathname === "/teams") {
    const body = await readBody(req);
    hive.teamStore.saveTeam(body);
    json(res, body, 201);
    return;
  }
  const teamStartMatch = pathname.match(/^\/teams\/([^/]+)\/start$/);
  if (method === "POST" && teamStartMatch) {
    const body = await readBody(req);
    const result = await hive.teamManager.startTeam(teamStartMatch[1], {
      prompt: body.prompt, cwd: body.cwd || hive.workspace, headless: true,
    });
    json(res, result);
    return;
  }
  const teamStopMatch = pathname.match(/^\/teams\/([^/]+)\/stop$/);
  if (method === "POST" && teamStopMatch) {
    const result = hive.teamManager.stopTeam(teamStopMatch[1]);
    json(res, result);
    return;
  }

  // --- Tickets ---
  if (method === "GET" && pathname === "/tickets") {
    const ticketService = require("./ticket-service");
    const status = url.searchParams.get("status");
    const label = url.searchParams.get("label");
    json(res, ticketService.listTickets({ status, label }));
    return;
  }
  if (method === "POST" && pathname === "/tickets") {
    const body = await readBody(req);
    const result = await hive.agentManager.handleOrchestratorCommand(
      { action: "ticket_create", ...body, createdBy: body.createdBy || "api" },
      () => hive.workspace
    );
    json(res, result, 201);
    return;
  }
  const ticketMatch = pathname.match(/^\/tickets\/([^/]+)$/);
  if (ticketMatch) {
    const ticketService = require("./ticket-service");
    if (method === "GET") {
      const t = ticketService.getTicket(ticketMatch[1]);
      if (!t) { json(res, { error: "not found" }, 404); return; }
      json(res, t);
      return;
    }
    if (method === "PUT") {
      const body = await readBody(req);
      body.ticketId = ticketMatch[1];
      const result = await hive.agentManager.handleOrchestratorCommand(
        { action: "ticket_update", ...body },
        () => hive.workspace
      );
      json(res, result);
      return;
    }
  }
  const ticketClaimMatch = pathname.match(/^\/tickets\/([^/]+)\/claim$/);
  if (method === "POST" && ticketClaimMatch) {
    const body = await readBody(req);
    const result = await hive.agentManager.handleOrchestratorCommand(
      { action: "ticket_claim", ticketId: ticketClaimMatch[1], agentId: body.agentId || "api", agentName: body.agentName || "API" },
      () => hive.workspace
    );
    json(res, result);
    return;
  }
  const ticketCompleteMatch = pathname.match(/^\/tickets\/([^/]+)\/complete$/);
  if (method === "POST" && ticketCompleteMatch) {
    const body = await readBody(req);
    const result = await hive.agentManager.handleOrchestratorCommand(
      { action: "ticket_complete", ticketId: ticketCompleteMatch[1], resultSummary: body.resultSummary, completedBy: body.completedBy || "api" },
      () => hive.workspace
    );
    json(res, result);
    return;
  }
  const ticketCommentMatch = pathname.match(/^\/tickets\/([^/]+)\/comment$/);
  if (method === "POST" && ticketCommentMatch) {
    const ticketService = require("./ticket-service");
    const body = await readBody(req);
    ticketService.addComment(ticketCommentMatch[1], body.agentId || "api", body.agentName || "API", body.content);
    json(res, { ok: true });
    return;
  }

  // --- Sprints ---
  if (method === "GET" && pathname === "/sprints") {
    const result = await hive.agentManager.handleOrchestratorCommand({ action: "sprint_list" }, () => hive.workspace);
    json(res, result);
    return;
  }
  if (method === "POST" && pathname === "/sprints") {
    const body = await readBody(req);
    const result = await hive.agentManager.handleOrchestratorCommand(
      { action: "sprint_create", name: body.name, ticketIds: body.ticketIds },
      () => hive.workspace
    );
    json(res, result, 201);
    return;
  }
  const sprintStartMatch = pathname.match(/^\/sprints\/([^/]+)\/start$/);
  if (method === "POST" && sprintStartMatch) {
    const result = await hive.agentManager.handleOrchestratorCommand(
      { action: "sprint_start", sprintId: sprintStartMatch[1] },
      () => hive.workspace
    );
    json(res, result);
    return;
  }
  const sprintEndMatch = pathname.match(/^\/sprints\/([^/]+)\/end$/);
  if (method === "POST" && sprintEndMatch) {
    const result = await hive.agentManager.handleOrchestratorCommand(
      { action: "sprint_end", sprintId: sprintEndMatch[1] },
      () => hive.workspace
    );
    json(res, result);
    return;
  }

  // --- Artifacts ---
  if (method === "GET" && pathname === "/artifacts") {
    const result = await hive.agentManager.handleOrchestratorCommand(
      { action: "artifact_list", type: url.searchParams.get("type"), tag: url.searchParams.get("tag") },
      () => hive.workspace
    );
    json(res, result);
    return;
  }
  if (method === "POST" && pathname === "/artifacts") {
    const body = await readBody(req);
    const result = await hive.agentManager.handleOrchestratorCommand(
      { action: "artifact_create", ...body, createdBy: body.createdBy || "api" },
      () => hive.workspace
    );
    json(res, result, 201);
    return;
  }
  const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)$/);
  if (method === "GET" && artifactMatch) {
    const result = await hive.agentManager.handleOrchestratorCommand(
      { action: "artifact_read", artifactId: artifactMatch[1] },
      () => hive.workspace
    );
    json(res, result);
    return;
  }

  // --- Skills ---
  if (method === "GET" && pathname === "/skills") {
    json(res, hive.hiveSkillStore.listHiveSkills());
    return;
  }
  if (method === "POST" && pathname === "/skills") {
    const body = await readBody(req);
    const saved = hive.hiveSkillStore.saveHiveSkill(body);
    json(res, saved, 201);
    return;
  }
  const skillMatch = pathname.match(/^\/skills\/([^/]+)$/);
  if (skillMatch) {
    if (method === "GET") {
      const s = hive.hiveSkillStore.getHiveSkill(skillMatch[1]);
      if (!s) { json(res, { error: "not found" }, 404); return; }
      json(res, s);
      return;
    }
    if (method === "DELETE") {
      const ok = hive.hiveSkillStore.deleteHiveSkill(skillMatch[1]);
      json(res, { ok });
      return;
    }
  }

  // --- Settings ---
  if (method === "GET" && pathname === "/settings") {
    const hiveSettingsStore = require("./hive-settings-store");
    json(res, hiveSettingsStore.getSettings());
    return;
  }
  if (method === "POST" && pathname === "/settings") {
    const hiveSettingsStore = require("./hive-settings-store");
    const body = await readBody(req);
    hiveSettingsStore.updateSettings(body);
    json(res, hiveSettingsStore.getSettings());
    return;
  }

  // --- Workspace ---
  if (method === "GET" && pathname === "/workspace") {
    const workspaceContext = require("./workspace-context");
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
      const result = await hive.agentManager.handleOrchestratorCommand(body, () => hive.workspace);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  // --- Hivemind ---
  if (method === "GET" && pathname === "/hivemind/agents") {
    const agents = hive.agentManager.listAgents()
      .filter((a) => a.state !== "terminated")
      .map((a) => ({ id: a.id, terminalId: a.terminalId, profileName: a.profileName, state: a.state, mode: a.mode }));
    json(res, agents);
    return;
  }
  if (method === "GET" && pathname === "/hivemind/inbox") {
    const agentId = url.searchParams.get("agentId");
    if (!agentId) { json(res, { error: "agentId required" }, 400); return; }
    const drain = url.searchParams.get("drain") === "true";
    const messages = drain
      ? hive.hivemindRouter.drainInbox(agentId)
      : hive.hivemindRouter.peekInbox(agentId);
    json(res, messages);
    return;
  }
  if (method === "POST" && pathname === "/hivemind/inbox") {
    const body = await readBody(req);
    if (body.toAgentId) {
      hive.hivemindRouter.deliverLocal(body.toAgentId, body);
    }
    json(res, { ok: true });
    return;
  }
  if (method === "POST" && pathname === "/hivemind/instruct") {
    const body = await readBody(req);
    const agents = hive.agentManager.listAgents();
    const lead = agents.find((a) => a.state === "active" && a.mode === "headless");
    if (!lead) { json(res, { ok: false, error: "no active agent" }, 404); return; }
    const payload = { type: "user", message: { role: "user", content: [{ type: "text", text: body.message }] } };
    const written = hive.agentManager.writeToAgent(lead.id, payload);
    json(res, { ok: written, agentId: lead.id });
    return;
  }
  if (method === "POST" && pathname === "/hivemind/events") {
    const body = await readBody(req);
    hive.hivemindEvents.pushEvent(body);
    json(res, { ok: true });
    return;
  }

  // --- Terminals ---
  if (method === "GET" && pathname === "/terminals") {
    const ptyHost = require("./pty-host");
    json(res, ptyHost.listTerminals());
    return;
  }

  // --- Task Router (Intelligence) ---
  if (method === "POST" && pathname === "/route") {
    const body = await readBody(req);
    const results = hive.taskRouter.route(body);
    json(res, results);
    return;
  }
  if (method === "GET" && pathname === "/route/stats") {
    json(res, hive.taskRouter.getStats());
    return;
  }
  if (method === "POST" && pathname === "/route/outcome") {
    const body = await readBody(req);
    hive.taskRouter.recordOutcome(body);
    json(res, { ok: true });
    return;
  }

  // --- Vector Memory ---
  if (method === "POST" && pathname === "/memory") {
    const body = await readBody(req);
    const result = hive.vectorMemory.store(body);
    json(res, result, 201);
    return;
  }
  if (method === "GET" && pathname === "/memory") {
    const query = url.searchParams.get("q");
    if (!query) { json(res, hive.vectorMemory.stats()); return; }
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);
    const tier = url.searchParams.get("tier") || undefined;
    const results = hive.vectorMemory.search(query, { limit, tier });
    json(res, results);
    return;
  }
  const memoryMatch = pathname.match(/^\/memory\/([^/]+)$/);
  if (memoryMatch) {
    if (method === "GET") {
      const entry = hive.vectorMemory.get(memoryMatch[1]);
      if (!entry) { json(res, { error: "not found" }, 404); return; }
      json(res, entry);
      return;
    }
    if (method === "DELETE") {
      const ok = hive.vectorMemory.delete(memoryMatch[1]);
      json(res, { ok });
      return;
    }
  }
  if (method === "POST" && pathname === "/memory/maintain") {
    const result = hive.vectorMemory.maintain();
    json(res, result);
    return;
  }

  // --- GOAP Planner ---
  if (method === "POST" && pathname === "/plans") {
    const body = await readBody(req);
    const plan = hive.goapPlanner.createPlan(body.goal, body.options);
    json(res, plan, 201);
    return;
  }
  if (method === "GET" && pathname === "/plans") {
    json(res, hive.goapPlanner.listPlans());
    return;
  }
  const planMatch = pathname.match(/^\/plans\/([^/]+)$/);
  if (planMatch) {
    if (method === "GET") {
      const status = hive.goapPlanner.getPlanStatus(planMatch[1]);
      if (!status) { json(res, { error: "not found" }, 404); return; }
      json(res, status);
      return;
    }
    if (method === "DELETE") {
      const ok = hive.goapPlanner.cancelPlan(planMatch[1]);
      json(res, { ok });
      return;
    }
  }
  const planExecMatch = pathname.match(/^\/plans\/([^/]+)\/execute$/);
  if (method === "POST" && planExecMatch) {
    hive.goapPlanner.executePlan(planExecMatch[1]).then((result) => {
      require("./event-bus-service").emit("plan:execution-done", { planId: planExecMatch[1], ...result });
    });
    json(res, { ok: true, message: "execution started" });
    return;
  }

  // --- Background Workers ---
  if (method === "GET" && pathname === "/workers") {
    json(res, hive.backgroundWorkers.list());
    return;
  }
  const workerMatch = pathname.match(/^\/workers\/([^/]+)$/);
  if (workerMatch) {
    if (method === "GET") {
      json(res, hive.backgroundWorkers.history(workerMatch[1]));
      return;
    }
  }
  const workerEnableMatch = pathname.match(/^\/workers\/([^/]+)\/enable$/);
  if (method === "POST" && workerEnableMatch) {
    const ok = hive.backgroundWorkers.enable(workerEnableMatch[1]);
    json(res, { ok });
    return;
  }
  const workerDisableMatch = pathname.match(/^\/workers\/([^/]+)\/disable$/);
  if (method === "POST" && workerDisableMatch) {
    const ok = hive.backgroundWorkers.disable(workerDisableMatch[1]);
    json(res, { ok });
    return;
  }
  const workerTriggerMatch = pathname.match(/^\/workers\/([^/]+)\/trigger$/);
  if (method === "POST" && workerTriggerMatch) {
    try {
      const result = await hive.backgroundWorkers.trigger(workerTriggerMatch[1]);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
    return;
  }

  // --- Modules ---
  if (method === "GET" && pathname === "/api/modules") {
    json(res, hive.moduleLoader.listModules());
    return;
  }
  const moduleMatch = pathname.match(/^\/api\/modules\/([^/]+)$/);
  if (moduleMatch) {
    if (method === "GET") {
      const modules = hive.moduleLoader.listModules();
      const mod = modules.find((m) => m.id === moduleMatch[1]);
      if (!mod) { json(res, { error: "not found" }, 404); return; }
      json(res, mod);
      return;
    }
    if (method === "PATCH") {
      const body = await readBody(req);
      if (body.enabled === true) {
        hive.moduleLoader.enableModule(moduleMatch[1]);
      } else if (body.enabled === false) {
        hive.moduleLoader.disableModule(moduleMatch[1]);
      }
      const modules = hive.moduleLoader.listModules();
      const mod = modules.find((m) => m.id === moduleMatch[1]);
      json(res, mod || { id: moduleMatch[1], enabled: body.enabled });
      return;
    }
  }
  const moduleConfigMatch = pathname.match(/^\/api\/modules\/([^/]+)\/config$/);
  if (moduleConfigMatch) {
    const workspaceContext = require("./workspace-context");
    const root = workspaceContext.getWorkspaceRoot();
    const configPath = path.join(root, ".zana", "config.json");
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
    const handled = await hive.moduleLoader.handleRoute(moduleRouteMatch[1], "/" + moduleRouteMatch[2], req, res);
    if (handled) return;
    json(res, { error: "module route not found" }, 404);
    return;
  }

  // --- Schedules ---
  if (method === "GET" && pathname === "/api/schedules") {
    const schedulerService = require("./scheduler-service");
    json(res, schedulerService.listSchedules());
    return;
  }
  if (method === "POST" && pathname === "/api/schedules") {
    const schedulerService = require("./scheduler-service");
    const body = await readBody(req);
    const schedule = schedulerService.createSchedule(body);
    json(res, schedule, 201);
    return;
  }
  const scheduleMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleMatch) {
    const schedulerService = require("./scheduler-service");
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
    const schedulerService = require("./scheduler-service");
    const result = schedulerService.enableSchedule(scheduleEnableMatch[1]);
    if (result.error) { json(res, result, 404); return; }
    json(res, result);
    return;
  }
  const scheduleDisableMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/disable$/);
  if (method === "POST" && scheduleDisableMatch) {
    const schedulerService = require("./scheduler-service");
    const result = schedulerService.disableSchedule(scheduleDisableMatch[1]);
    if (result.error) { json(res, result, 404); return; }
    json(res, result);
    return;
  }
  const scheduleTriggerMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/trigger$/);
  if (method === "POST" && scheduleTriggerMatch) {
    const schedulerService = require("./scheduler-service");
    const result = await schedulerService.triggerSchedule(scheduleTriggerMatch[1]);
    if (result.error) { json(res, result, 404); return; }
    json(res, result);
    return;
  }

  // --- Checkpoints ---
  if (method === "GET" && pathname === "/api/checkpoints") {
    const checkpointStore = require("./checkpoint/store");
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
    const checkpointStore = require("./checkpoint/store");
    const body = await readBody(req);
    const checkpoint = checkpointStore.save(body);
    json(res, checkpoint, 201);
    return;
  }
  const checkpointMatch = pathname.match(/^\/api\/checkpoints\/([^/]+)$/);
  if (checkpointMatch) {
    const checkpointStore = require("./checkpoint/store");
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
    const checkpointResume = require("./checkpoint/resume");
    const result = await checkpointResume.resume(
      checkpointResumeMatch[1],
      hive.agentManager,
      hive.profileStore
    );
    if (!result.ok) { json(res, result, result.error === "checkpoint not found" ? 404 : 400); return; }
    json(res, result);
    return;
  }

  // --- Workflows ---
  if (method === "POST" && pathname === "/api/workflows/run") {
    const workflowEngine = require("./workflow-engine");
    const body = await readBody(req);
    if (!body.skill && !body.steps) { json(res, { error: "skill or steps required" }, 400); return; }
    const skill = body.skill || { id: body.id || "inline", name: body.name || "inline", steps: body.steps };
    const run = await workflowEngine.executeWorkflow(skill, body.triggerContext || {});
    if (run.error) { json(res, run, 400); return; }
    json(res, run, 201);
    return;
  }
  if (method === "GET" && pathname === "/api/workflows/runs") {
    const workflowEngine = require("./workflow-engine");
    const filter = {};
    const status = url.searchParams.get("status");
    if (status) filter.status = status;
    json(res, workflowEngine.listRuns(filter));
    return;
  }
  const workflowRunMatch = pathname.match(/^\/api\/workflows\/runs\/([^/]+)$/);
  if (method === "GET" && workflowRunMatch) {
    const workflowEngine = require("./workflow-engine");
    const run = workflowEngine.loadRun(workflowRunMatch[1]);
    if (!run) { json(res, { error: "not found" }, 404); return; }
    json(res, run);
    return;
  }

  // --- Autopilot Goals ---
  if (method === "GET" && pathname === "/api/autopilot/goals") {
    const autopilot = hive.moduleLoader.getModule("autopilot");
    if (!autopilot || !autopilot.api) { json(res, { error: "autopilot module not available" }, 503); return; }
    const filter = {};
    const status = url.searchParams.get("status");
    if (status) filter.status = status;
    json(res, autopilot.api.listGoals(filter));
    return;
  }
  if (method === "POST" && pathname === "/api/autopilot/goals") {
    const autopilot = hive.moduleLoader.getModule("autopilot");
    if (!autopilot || !autopilot.api) { json(res, { error: "autopilot module not available" }, 503); return; }
    const body = await readBody(req);
    const goal = autopilot.api.setGoal(body);
    json(res, goal, 201);
    return;
  }
  const autopilotGoalMatch = pathname.match(/^\/api\/autopilot\/goals\/([^/]+)$/);
  if (autopilotGoalMatch) {
    const autopilot = hive.moduleLoader.getModule("autopilot");
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

  const pluginLoader = require("./plugin-loader");
  if (pathname.startsWith("/x/") && pluginLoader.handlePluginRoute(pathname, req, res)) {
    return;
  }

  json(res, { error: "not found" }, 404);
}

export function start(hive, port, options = {}) {
  hiveInstance = hive;
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

