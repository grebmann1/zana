import * as http from "node:http";
import * as url from "node:url";
function _core() { return require("@zana/core"); }
const workspaceContext: any = new Proxy({}, { get: (_t, p) => _core().project.workspaceContext[p] });
function appendAudit(...args: any[]) { return _core().events.log.appendAudit(...args); }
const ticketService: any = new Proxy({}, { get: (_t, p) => require("@zana/work").tickets.service[p] });
const schedulerService: any = new Proxy({}, { get: (_t, p) => require("@zana/work").scheduling.service[p] });
const eventBusService: any = new Proxy({}, { get: (_t, p) => _core().events.service[p] });

function DEFAULT_PORT() { return _core().config.DEFAULT_HOOK_PORT; }
const MAX_BODY_BYTES = 256 * 1024;
const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

let swarmRouter = null;
let swarmEvents = null;
let agentListFn = null;

// --- Route registry ---
const routes = new Map();

export function registerRoute(method, pathname, handler) {
  routes.set(`${method.toUpperCase()} ${pathname}`, handler);
}

function matchRoute(method, pathname) {
  return routes.get(`${method} ${pathname}`) || null;
}

export function setSwarmModules({ router, events, getAgents }) {
  swarmRouter = router;
  swarmEvents = events;
  agentListFn = getAgents;
}

export function startHookServer(onHook, orchestratorHandler, preferredPort: any = undefined, { getMainWindow }: any = {}) {
  if (preferredPort === undefined) preferredPort = DEFAULT_PORT();
  // Register built-in routes
  registerBuiltInRoutes(onHook, orchestratorHandler, getMainWindow);

  return new Promise((resolve) => {
    let port = preferredPort;
    let attempts = 0;

    const server = http.createServer((req, res) => {
      const remote = req.socket.remoteAddress;
      const loopback =
        remote === "127.0.0.1" ||
        remote === "::1" ||
        remote === "::ffff:127.0.0.1";
      if (!loopback) {
        res.statusCode = 403;
        res.end();
        return;
      }

      const parsed = url.parse(req.url, true);
      const handler = matchRoute(req.method, parsed.pathname);

      if (handler) {
        if (req.method === "GET") {
          handler(req, res, parsed);
        } else {
          readBody(req, (err, body) => {
            if (err) {
              res.statusCode = err === "too_large" ? 413 : 400;
              res.end();
              return;
            }
            try {
              const data = JSON.parse(body);
              handler(req, res, data);
            } catch (parseErr) {
              console.warn("[hook-server] JSON parse error:", parseErr.message || parseErr);
              res.statusCode = 400;
              res.end();
            }
          });
        }
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && attempts < 20) {
        attempts += 1;
        port += 1;
        try {
          server.listen(port, "127.0.0.1");
        } catch (listenErr) {
          console.warn("[hook-server] listen retry failed:", listenErr.message || listenErr);
          resolve(null);
        }
      } else {
        console.warn(
          `[hook-server] couldn't bind to ${port}:`,
          err.message ?? err,
        );
        resolve(null);
      }
    });

    server.on("listening", () => {
      process.stderr.write(`[hook-server] listening on 127.0.0.1:${port}\n`);
      resolve({
        port,
        stop() {
          try { server.close(); } catch (err) {
            console.warn("[hook-server] error closing server:", err.message || err);
          }
        },
      });
    });

    server.listen(port, "127.0.0.1");
  });
}

function readBody(req, cb) {
  let body = "";
  let aborted = false;
  req.on("data", (chunk) => {
    if (aborted) return;
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      aborted = true;
      req.destroy();
      cb("too_large");
    }
  });
  req.on("end", () => {
    if (!aborted) cb(null, body);
  });
}

function registerServiceRoutes() {
  // --- Event Bus Routes ---
  registerRoute("POST", "/events/emit", (_req, res, data) => {
    eventBusService.emit(data.type, data.payload, data.tags);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  registerRoute("GET", "/events/query", (_req, res, parsed) => {
    const filter = {};
    if (parsed.query.types) filter.types = parsed.query.types.split(",");
    if (parsed.query.source) filter.source = parsed.query.source;
    if (parsed.query.since) filter.since = parseInt(parsed.query.since, 10);
    const limit = parsed.query.limit ? parseInt(parsed.query.limit, 10) : 100;
    const events = eventBusService.query(filter, limit);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(events));
  });

  // --- Ticket Routes ---
  registerRoute("GET", "/tickets", (_req, res, parsed) => {
    const filter = {};
    if (parsed.query.status) filter.status = parsed.query.status;
    if (parsed.query.sprintId) filter.sprintId = parsed.query.sprintId;
    if (parsed.query.assigneeId) filter.assigneeId = parsed.query.assigneeId;
    if (parsed.query.label) filter.label = parsed.query.label;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(ticketService.listTickets(filter)));
  });

  registerRoute("POST", "/tickets", (_req, res, data) => {
    const ticket = ticketService.createTicket(data);
    appendAudit({ action: "ticket_created", ticketId: ticket.id, title: ticket.title, workspace: workspaceContext.isInitialized() ? workspaceContext.getWorkspaceRoot() : null });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(ticket));
  });

  registerRoute("POST", "/tickets/claim", (_req, res, data) => {
    const result = ticketService.claimTicket(data.ticketId, data.agentId, data.agentName);
    res.statusCode = result.error ? 400 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });

  registerRoute("POST", "/tickets/status", (_req, res, data) => {
    const result = ticketService.updateStatus(data.ticketId, data.status, data.updatedBy);
    if (!result.error) {
      appendAudit({ action: "ticket_status_changed", ticketId: data.ticketId, status: data.status, updatedBy: data.updatedBy });
    }
    res.statusCode = result.error ? 400 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });

  registerRoute("POST", "/tickets/comment", (_req, res, data) => {
    const result = ticketService.addComment(data.ticketId, data.authorId, data.authorName, data.body);
    res.statusCode = result.error ? 400 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });

  registerRoute("POST", "/tickets/complete", (_req, res, data) => {
    const result = ticketService.completeTicket(data.ticketId, data.resultSummary, data.completedBy);
    if (!result.error) {
      appendAudit({ action: "ticket_completed", ticketId: data.ticketId, completedBy: data.completedBy });
    }
    res.statusCode = result.error ? 400 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });

  // --- Sprint Routes ---
  registerRoute("GET", "/sprints", (_req, res, parsed) => {
    const filter = {};
    if (parsed.query.teamId) filter.teamId = parsed.query.teamId;
    if (parsed.query.status) filter.status = parsed.query.status;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(ticketService.listSprints(filter)));
  });

  registerRoute("POST", "/sprints", (_req, res, data) => {
    const sprint = ticketService.createSprint(data);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(sprint));
  });

  registerRoute("POST", "/sprints/start", (_req, res, data) => {
    const result = ticketService.startSprint(data.sprintId);
    res.statusCode = result.error ? 400 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });

  registerRoute("POST", "/sprints/end", (_req, res, data) => {
    const result = ticketService.endSprint(data.sprintId);
    res.statusCode = result.error ? 400 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });

  // --- Scheduler Routes ---
  registerRoute("GET", "/scheduler/list", (_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(schedulerService.listSchedules()));
  });

  registerRoute("POST", "/scheduler", (_req, res, data) => {
    const schedule = schedulerService.createSchedule(data);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(schedule));
  });

  registerRoute("POST", "/scheduler/update", (_req, res, data) => {
    const { id, ...fields } = data;
    const result = schedulerService.updateSchedule(id, fields);
    res.statusCode = result.error ? 400 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });

  registerRoute("POST", "/scheduler/delete", (_req, res, data) => {
    schedulerService.deleteSchedule(data.id);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  registerRoute("POST", "/scheduler/enable", (_req, res, data) => {
    const result = schedulerService.enableSchedule(data.id);
    res.statusCode = result.error ? 400 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });

  registerRoute("POST", "/scheduler/disable", (_req, res, data) => {
    const result = schedulerService.disableSchedule(data.id);
    res.statusCode = result.error ? 400 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });

  registerRoute("POST", "/scheduler/trigger", (_req, res, data) => {
    const result = schedulerService.triggerSchedule(data.id);
    res.statusCode = result.error ? 400 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });
}

function registerBuiltInRoutes(onHook, orchestratorHandler, getMainWindow) {
  registerServiceRoutes();

  // GET /health — instance health check
  registerRoute("GET", "/health", (_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      hiveId: process.env.ZANA_ID || null,
      workspace: process.env.ZANA_WORKSPACE || null,
      pid: process.pid,
    }));
  });

  // GET /focus — bring main window to front
  registerRoute("GET", "/focus", (_req, res) => {
    const win = getMainWindow ? getMainWindow() : null;
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  // POST /hook — Claude hook events
  registerRoute("POST", "/hook", (_req, res, data) => {
    try { onHook(data); } catch (err) {
      console.warn("[hook-server] onHook threw:", err);
    }

    // Audit trail for agent lifecycle events
    try {
      const hookEvent = data.hook_event_name;
      if (hookEvent === "SessionEnd" || hookEvent === "Stop") {
        const agentId = data.zana_terminal_id;
        if (agentId) {
          appendAudit({ action: "agent_completed", agentId, hookEvent, result: data.stop_reason || null });
        }
      }
    } catch (auditErr) {
      console.warn("[hook-server] audit write failed:", auditErr.message || auditErr);
    }

    res.statusCode = 204;
    res.end();
  });

  // POST /orchestrator — orchestrator commands
  registerRoute("POST", "/orchestrator", async (_req, res, data) => {
    try {
      const result = await orchestratorHandler(data);

      // Audit trail for important orchestrator actions
      try {
        const workspace = workspaceContext.isInitialized() ? workspaceContext.getWorkspaceRoot() : null;
        if (data.action === "spawn_agent" && result.agentId) {
          appendAudit({ action: "agent_spawned", agentId: result.agentId, profileId: data.profileId, workspace });
        } else if (data.action === "kill_agent" && result.ok) {
          appendAudit({ action: "agent_killed", agentId: data.agentId, workspace });
        }
      } catch (auditErr) {
        console.warn("[hook-server] audit write failed:", auditErr.message || auditErr);
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });

  // POST /swarm/inbox — deliver message to agent inbox
  registerRoute("POST", "/swarm/inbox", (_req, res, data) => {
    if (!swarmRouter) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "swarm not initialized" }));
      return;
    }
    const toAgentId = data.toAgentId;
    if (!toAgentId) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "toAgentId required" }));
      return;
    }
    swarmRouter.deliverLocal(toAgentId, data);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  // POST /swarm/events — receive events from sub-hives
  registerRoute("POST", "/swarm/events", (_req, res, data) => {
    if (!swarmEvents) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "swarm not initialized" }));
      return;
    }
    swarmEvents.addEvent(data);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  // GET /swarm/inbox — drain/peek agent inbox
  registerRoute("GET", "/swarm/inbox", (_req, res, parsed) => {
    if (!swarmRouter) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "swarm not initialized" }));
      return;
    }
    const agentId = parsed.query.agentId;
    if (!agentId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "agentId required" }));
      return;
    }
    if (!AGENT_ID_PATTERN.test(agentId)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid agentId format" }));
      return;
    }
    const drain = parsed.query.drain === "true";
    const messages = drain
      ? swarmRouter.drainInbox(agentId)
      : swarmRouter.peekInbox(agentId);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(messages));
  });

  // GET /swarm/agents — list active agents
  registerRoute("GET", "/swarm/agents", (_req, res) => {
    const agents = agentListFn ? agentListFn() : [];
    const mapped = agents
      .filter((a) => a.state !== "terminated")
      .map((a) => ({
        id: a.id,
        terminalId: a.terminalId,
        profileName: a.profileName,
        profileIcon: a.profileIcon,
        state: a.state,
        mode: a.mode,
        hiveId: process.env.ZANA_ID || "unknown",
      }));
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(mapped));
  });
}

export { DEFAULT_PORT };
