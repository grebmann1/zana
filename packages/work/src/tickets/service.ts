import * as crypto from "node:crypto";
import * as ticketStore from "./db";
function _bus(): any { return require("@zana-ai/core").events.bus; }

const VALID_STATUSES = ["backlog", "in-progress", "review", "rework", "blocked", "done", "cancelled"];
const VALID_PRIORITIES = ["critical", "high", "medium", "low"];

const STATUS_TRANSITIONS = {
  "backlog": ["in-progress", "cancelled"],
  "in-progress": ["review", "done", "backlog", "cancelled"],
  "review": ["done", "rework", "in-progress", "cancelled"],
  "rework": ["in-progress", "blocked", "cancelled"],
  "blocked": ["in-progress", "backlog", "cancelled"],
  "done": ["backlog"],
  "cancelled": ["backlog"],
};

function addAuditEntry(ticket, action, actor, details) {
  if (!ticket.audit) ticket.audit = [];
  ticket.audit.push({
    id: crypto.randomUUID(),
    action,
    actor: actor || "system",
    details: details || null,
    timestamp: new Date().toISOString(),
  });
}

export function createTicket({ title, description, priority, labels, blockedBy, sprintId, createdBy }) {
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return { error: "title is required" };
  }

  // Auto-attach to the active sprint when caller didn't pick one. Without this
  // every untracked ticket becomes a permanent orphan with sprintId=null and
  // no end-of-sprint reconciliation can ever reach it.
  let resolvedSprintId = sprintId || null;
  if (!resolvedSprintId) {
    try {
      const active = ticketStore.listSprints({ status: "active" });
      if (active && active.length > 0) {
        resolvedSprintId = active[0].id;
      }
    } catch {
      // sprints dir may not exist yet — leave null and continue
    }
  }

  const now = new Date().toISOString();
  const ticket = {
    id: crypto.randomUUID(),
    title,
    description: description || "",
    status: "backlog",
    priority: VALID_PRIORITIES.includes(priority) ? priority : "medium",
    assigneeId: null,
    assigneeName: null,
    assigneeProfileId: null,
    reviewPhase: null,
    reworkCount: 0,
    sprintId: resolvedSprintId,
    labels: labels || [],
    blockedBy: blockedBy || [],
    comments: [],
    audit: [],
    createdBy: createdBy || "system",
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    resultSummary: null,
  };

  addAuditEntry(ticket, "created", createdBy, { title, priority: ticket.priority });
  ticketStore.saveTicket(ticket);
  _bus().emit("ticket:created", { ticketId: ticket.id, title: ticket.title, priority: ticket.priority });

  if (resolvedSprintId) {
    const sprint = ticketStore.getSprint(resolvedSprintId);
    if (sprint) {
      if (!sprint.ticketIds) sprint.ticketIds = [];
      if (!sprint.ticketIds.includes(ticket.id)) {
        sprint.ticketIds.push(ticket.id);
        sprint.updatedAt = new Date().toISOString();
        ticketStore.saveSprint(sprint);
      }
    }
  }
  return ticket;
}

export function claimTicket(ticketId, agentId, agentName, profileId?) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (ticket.status !== "backlog" && ticket.status !== "rework") {
    return { error: `cannot claim ticket in status: ${ticket.status}` };
  }

  const oldStatus = ticket.status;
  ticket.assigneeId = agentId;
  ticket.assigneeName = agentName || agentId;
  if (profileId) ticket.assigneeProfileId = profileId;
  ticket.status = "in-progress";
  ticket.reviewPhase = null;
  ticket.updatedAt = new Date().toISOString();

  addAuditEntry(ticket, "claimed", agentId, { agentName: ticket.assigneeName, profileId });
  addAuditEntry(ticket, "status_changed", agentId, { from: oldStatus, to: "in-progress" });
  ticketStore.saveTicket(ticket);
  _bus().emit("ticket:claimed", { ticketId, agentId, agentName: ticket.assigneeName, profileId });
  return { ok: true, ticket };
}

export function updateStatus(ticketId, newStatus, updatedBy) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (!VALID_STATUSES.includes(newStatus)) return { error: `invalid status: ${newStatus}` };

  const allowed = STATUS_TRANSITIONS[ticket.status];
  if (!allowed || !allowed.includes(newStatus)) {
    return { error: `cannot transition from ${ticket.status} to ${newStatus}` };
  }

  const oldStatus = ticket.status;
  ticket.status = newStatus;
  ticket.updatedAt = new Date().toISOString();
  if (newStatus === "done" || newStatus === "cancelled") {
    ticket.closedAt = ticket.updatedAt;
  }
  if (newStatus === "review" && !ticket.reviewPhase) {
    ticket.reviewPhase = "qa";
  }
  if (newStatus === "rework") {
    ticket.reviewPhase = null;
    ticket.reworkCount = (ticket.reworkCount || 0) + 1;
  }

  addAuditEntry(ticket, "status_changed", updatedBy, { from: oldStatus, to: newStatus });
  ticketStore.saveTicket(ticket);
  _bus().emit("ticket:statusChanged", { ticketId, oldStatus, newStatus, updatedBy });
  return { ok: true, ticket };
}

export function completeTicket(ticketId, resultSummary, completedBy) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };

  const oldStatus = ticket.status;
  ticket.status = "done";
  ticket.resultSummary = resultSummary || null;
  ticket.closedAt = new Date().toISOString();
  ticket.updatedAt = ticket.closedAt;

  addAuditEntry(ticket, "status_changed", completedBy, { from: oldStatus, to: "done" });
  addAuditEntry(ticket, "completed", completedBy, { resultSummary });
  ticketStore.saveTicket(ticket);
  _bus().emit("ticket:completed", { ticketId, completedBy, resultSummary });
  return { ok: true, ticket };
}

export function addComment(ticketId, authorId, authorName, body) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };

  const comment = {
    id: crypto.randomUUID(),
    authorId,
    authorName: authorName || authorId,
    body,
    createdAt: new Date().toISOString(),
  };

  ticket.comments.push(comment);
  ticket.updatedAt = comment.createdAt;

  addAuditEntry(ticket, "commented", authorId, { commentId: comment.id, body: body.slice(0, 100) });
  ticketStore.saveTicket(ticket);
  _bus().emit("ticket:commented", { ticketId, commentId: comment.id, authorId });
  return { ok: true, comment };
}

const VALID_TYPES = ["bug", "feature", "chore", "spike"];
const UPDATABLE_FIELDS = ["title", "description", "priority", "labels", "sprintId", "blockedBy", "type"];

export function updateTicket(ticketId, fields, updatedBy) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };

  if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) {
    return { error: "no fields provided" };
  }

  // Validate title if provided
  if ("title" in fields) {
    if (!fields.title || typeof fields.title !== "string" || fields.title.trim().length === 0) {
      return { error: "title must be a non-empty string" };
    }
  }

  // Validate priority if provided
  if ("priority" in fields) {
    if (!VALID_PRIORITIES.includes(fields.priority)) {
      return { error: `invalid priority: ${fields.priority}. Must be one of: ${VALID_PRIORITIES.join(", ")}` };
    }
  }

  // Validate type if provided
  if ("type" in fields) {
    if (!VALID_TYPES.includes(fields.type)) {
      return { error: `invalid type: ${fields.type}. Must be one of: ${VALID_TYPES.join(", ")}` };
    }
  }

  const changedFields = [];

  for (const key of UPDATABLE_FIELDS) {
    if (key in fields) {
      ticket[key] = fields[key];
      changedFields.push(key);
    }
  }

  if (changedFields.length === 0) {
    return { error: "no valid updatable fields provided" };
  }

  ticket.updatedAt = new Date().toISOString();
  addAuditEntry(ticket, "updated", updatedBy, { fields: changedFields });
  ticketStore.saveTicket(ticket);
  _bus().emit("ticket:updated", { ticketId, fields: Object.keys(fields), updatedBy });
  return { ok: true, ticket };
}

export function addTicketToSprint(ticketId, sprintId) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };

  const sprint = ticketStore.getSprint(sprintId);
  if (!sprint) return { error: "sprint not found" };

  // Add ticketId to sprint if not already present
  if (!sprint.ticketIds) sprint.ticketIds = [];
  if (!sprint.ticketIds.includes(ticketId)) {
    sprint.ticketIds.push(ticketId);
    sprint.updatedAt = new Date().toISOString();
    ticketStore.saveSprint(sprint);
  }

  // Update the ticket's sprintId
  ticket.sprintId = sprintId;
  ticket.updatedAt = new Date().toISOString();
  addAuditEntry(ticket, "updated", "system", { fields: ["sprintId"] });
  ticketStore.saveTicket(ticket);

  _bus().emit("ticket:updated", { ticketId, fields: ["sprintId"], updatedBy: "system" });
  return { ok: true, ticket, sprint };
}

export function getSprintBoard(sprintId) {
  const tickets = ticketStore.listTickets({ sprintId });
  const board = {
    backlog: [],
    "in-progress": [],
    review: [],
    rework: [],
    blocked: [],
    done: [],
  };

  for (const ticket of tickets) {
    if (board[ticket.status]) {
      board[ticket.status].push(ticket);
    }
  }

  return board;
}

export function createSprint({ name, teamId, daemonId, ticketIds }) {
  const now = new Date().toISOString();
  const sprint = {
    id: crypto.randomUUID(),
    name,
    teamId: teamId || null,
    daemonId: daemonId || null,
    status: "planning",
    ticketIds: ticketIds || [],
    startedAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  ticketStore.saveSprint(sprint);

  // Backfill sprintId on each member ticket (bidirectional link)
  for (const ticketId of sprint.ticketIds) {
    const ticket = ticketStore.getTicket(ticketId);
    if (!ticket) continue;
    ticket.sprintId = sprint.id;
    ticket.updatedAt = now;
    addAuditEntry(ticket, "added_to_sprint", "system", { sprintId: sprint.id });
    ticketStore.saveTicket(ticket);
  }

  _bus().emit("sprint:created", { sprintId: sprint.id, name: sprint.name });
  return sprint;
}

export function startSprint(sprintId) {
  const sprint = ticketStore.getSprint(sprintId);
  if (!sprint) return { error: "sprint not found" };
  if (sprint.status !== "planning") return { error: `cannot start sprint in status: ${sprint.status}` };

  sprint.status = "active";
  sprint.startedAt = new Date().toISOString();
  sprint.updatedAt = sprint.startedAt;

  ticketStore.saveSprint(sprint);
  _bus().emit("sprint:started", { sprintId, name: sprint.name });
  return { ok: true, sprint };
}

export function endSprint(sprintId) {
  const sprint = ticketStore.getSprint(sprintId);
  if (!sprint) return { error: "sprint not found" };
  if (sprint.status !== "active") return { error: `cannot end sprint in status: ${sprint.status}` };

  sprint.status = "completed";
  sprint.endedAt = new Date().toISOString();
  sprint.updatedAt = sprint.endedAt;

  ticketStore.saveSprint(sprint);
  _bus().emit("sprint:ended", { sprintId, name: sprint.name });
  return { ok: true, sprint };
}

export function updateReviewPhase(ticketId, phase, updatedBy) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (ticket.status !== "review") return { error: "ticket not in review status" };

  const validPhases = ["qa", "architecture"];
  if (!validPhases.includes(phase)) return { error: `invalid review phase: ${phase}` };

  const oldPhase = ticket.reviewPhase;
  ticket.reviewPhase = phase;
  ticket.updatedAt = new Date().toISOString();

  addAuditEntry(ticket, "review_phase_changed", updatedBy, { from: oldPhase, to: phase });
  ticketStore.saveTicket(ticket);
  _bus().emit("ticket:reviewPhaseChanged", { ticketId, oldPhase, newPhase: phase, updatedBy });
  return { ok: true, ticket };
}

export const listTickets = (ticketStore as any).listTickets;
export const getTicket = (ticketStore as any).getTicket;
export const deleteTicket = (ticketStore as any).deleteTicket;
export const listSprints = (ticketStore as any).listSprints;
export const getSprint = (ticketStore as any).getSprint;
export const deleteSprint = (ticketStore as any).deleteSprint;
