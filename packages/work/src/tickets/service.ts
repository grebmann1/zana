import * as crypto from "node:crypto";
import * as ticketStore from "./db";
function _bus(): any { return require("@zana-ai/core").events.bus; }

const VALID_STATUSES = ["backlog", "in-progress", "review", "rework", "blocked", "done", "cancelled"];
const VALID_PRIORITIES = ["critical", "high", "medium", "low"];

// Lower rank = dispatched first. Unknown priorities sort as "medium".
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// A dependency stops blocking once it reaches a terminal status. A referenced
// ticket that no longer exists is treated as resolved — blocking forever on a
// deleted dependency would deadlock the dependent ticket.
function isDependencyClosed(status) {
  return status === "done" || status === "cancelled";
}

// Returns the subset of `ticket.blockedBy` that are still open (i.e. genuinely
// blocking). Missing dependencies are dropped, not counted.
export function getOpenBlockers(ticket) {
  const deps = Array.isArray(ticket?.blockedBy) ? ticket.blockedBy : [];
  const open: string[] = [];
  for (const depId of deps) {
    const dep = ticketStore.getTicket(depId);
    if (!dep) continue;
    if (!isDependencyClosed(dep.status)) open.push(depId);
  }
  return open;
}

// Detects whether pointing `ticketId`'s blockedBy at `newBlockedBy` would
// introduce a cycle. Walks the dependency graph from each proposed blocker; if
// the walk reaches `ticketId` itself, the edge would close a loop (including a
// direct self-reference).
function wouldCreateCycle(ticketId, newBlockedBy) {
  const visited = new Set<string>();
  const stack = [...newBlockedBy];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === ticketId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const dep = ticketStore.getTicket(cur);
    if (dep && Array.isArray(dep.blockedBy)) stack.push(...dep.blockedBy);
  }
  return false;
}

// Walks the parentId chain upward from `startParentId`. Returns true if the
// chain reaches `ticketId` (a cycle) — including a direct self-parent. Unlike
// blockedBy (a DAG), parentId is a strict tree: each ticket has at most one
// parent, so this is a linear walk, not a graph traversal. A missing parent
// terminates the walk (treated as a root).
function wouldCreateParentCycle(ticketId, startParentId) {
  let cur = startParentId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === ticketId) return true;
    if (seen.has(cur)) break; // pre-existing loop elsewhere — don't spin forever
    seen.add(cur);
    const parent = ticketStore.getTicket(cur);
    cur = parent ? parent.parentId : null;
  }
  return false;
}

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

export function createTicket({ title, description, priority, labels, blockedBy, sprintId, createdBy, parentId }) {
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return { error: "title is required" };
  }

  // Validate the parent link, if any. The parent must exist; a child can't be
  // its own ancestor. (A freshly minted id can't yet appear in any chain, so
  // the cycle check here only catches a parent that doesn't resolve — kept for
  // symmetry with updateTicket where re-parenting can form a real loop.)
  let resolvedParentId = parentId || null;
  if (resolvedParentId) {
    const parent = ticketStore.getTicket(resolvedParentId);
    if (!parent) return { error: `parent ticket not found: ${resolvedParentId}` };
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

  const id = crypto.randomUUID();

  // Reject a cycle at create time. A freshly minted id can't be referenced by
  // any existing ticket yet, so the only loop expressible here is a direct
  // self-reference (blockedBy contains this id) — which the caller can't
  // construct without knowing the id. The check is kept for symmetry with
  // updateTicket, where the real cycle protection lives. blockedBy is an
  // arbitrary graph; a cycle would deadlock every ticket on the loop, since
  // none can ever reach a terminal status to unblock the others.
  const deps = Array.isArray(blockedBy) ? blockedBy : [];
  if (deps.length > 0 && wouldCreateCycle(id, deps)) {
    return { error: "blockedBy would create a dependency cycle" };
  }

  const now = new Date().toISOString();
  const ticket = {
    id,
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
    parentId: resolvedParentId,
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

// Bind a profile to a ticket out of band (e.g. the auto-router at creation
// time). Never overrides an already-bound profile — human/explicit intent wins.
// When profileId is null/empty, the ticket is left unassigned and tagged
// `needs-triage` so a human knows the router wasn't confident. Returns
// { ok, assigned } so callers can tell whether a binding happened.
export function assignProfile(ticketId, profileId, assignedBy?) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (ticket.assigneeProfileId) {
    return { ok: true, assigned: false, reason: "already_assigned" };
  }
  if (profileId) {
    ticket.assigneeProfileId = profileId;
    ticket.updatedAt = new Date().toISOString();
    addAuditEntry(ticket, "profile_assigned", assignedBy || "auto-router", { profileId });
    ticketStore.saveTicket(ticket);
    _bus().emit("ticket:updated", { ticketId, fields: ["assigneeProfileId"], updatedBy: assignedBy || "auto-router" });
    return { ok: true, assigned: true, profileId };
  }
  // No confident profile — flag for human triage (idempotent).
  if (!Array.isArray(ticket.labels)) ticket.labels = [];
  if (!ticket.labels.includes("needs-triage")) {
    ticket.labels.push("needs-triage");
    ticket.updatedAt = new Date().toISOString();
    addAuditEntry(ticket, "updated", assignedBy || "auto-router", { fields: ["labels"], added: "needs-triage" });
    ticketStore.saveTicket(ticket);
    _bus().emit("ticket:updated", { ticketId, fields: ["labels"], updatedBy: assignedBy || "auto-router" });
  }
  return { ok: true, assigned: false, reason: "no_confident_profile" };
}

// Escalate a ticket to the design-only lane: park it with the
// `awaiting-decision` label (which the auto-implement rule skips), bind the
// architect profile, and emit "ticket:escalated" so the watcher spawns a
// design-only architect. Idempotent — re-escalating a parked ticket is a no-op.
export function escalateForDesign(ticketId, reason, escalatedBy?) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (!Array.isArray(ticket.labels)) ticket.labels = [];
  if (ticket.labels.includes("awaiting-decision")) {
    return { ok: true, escalated: false, reason: "already_parked" };
  }
  ticket.labels.push("awaiting-decision");
  // Bind architect for the design pass unless a profile is already chosen.
  if (!ticket.assigneeProfileId) ticket.assigneeProfileId = "architect";
  ticket.updatedAt = new Date().toISOString();
  addAuditEntry(ticket, "escalated", escalatedBy || "auto-router", { reason: reason || null });
  ticketStore.saveTicket(ticket);
  _bus().emit("ticket:escalated", { ticketId, reason: reason || null, escalatedBy: escalatedBy || "auto-router" });
  return { ok: true, escalated: true };
}

// Direct children of an epic/parent ticket. Read-only.
export function getChildren(ticketId) {
  return ticketStore.listTickets({ parentId: ticketId });
}

// When a child reaches a terminal status, check whether its parent epic is now
// fully resolved (every child done/cancelled) and, if so, auto-complete the
// epic. An epic with no remaining open children has nothing left to do — leaving
// it open forever is the "ghost epic" problem. Idempotent: a parent already in a
// terminal status is left untouched. Only fires for parents that are themselves
// still open and have at least one child (a leaf ticket with no children is not
// an epic). Returns the parent id if it was auto-completed, else null.
function maybeCompleteParentEpic(childTicket, actor) {
  const parentId = childTicket?.parentId;
  if (!parentId) return null;
  const parent = ticketStore.getTicket(parentId);
  if (!parent) return null;
  if (parent.status === "done" || parent.status === "cancelled") return null;

  const children = getChildren(parentId);
  if (children.length === 0) return null;
  const allClosed = children.every(
    (c) => c.status === "done" || c.status === "cancelled",
  );
  if (!allClosed) return null;

  // Force the epic to done regardless of its current column — the children
  // already attest the work is finished, and the epic's own status is a roll-up,
  // not an independently-driven state. (Same forced-terminal rationale as
  // completeTicket.)
  const doneCount = children.filter((c) => c.status === "done").length;
  const oldStatus = parent.status;
  parent.status = "done";
  parent.closedAt = new Date().toISOString();
  parent.updatedAt = parent.closedAt;
  parent.resultSummary =
    parent.resultSummary ||
    `Auto-completed: all ${children.length} child tickets resolved (${doneCount} done, ${children.length - doneCount} cancelled).`;
  addAuditEntry(parent, "status_changed", actor || "system", { from: oldStatus, to: "done" });
  addAuditEntry(parent, "epic_auto_completed", actor || "system", {
    childCount: children.length,
    doneCount,
  });
  ticketStore.saveTicket(parent);
  _bus().emit("ticket:completed", {
    ticketId: parent.id,
    completedBy: actor || "system",
    resultSummary: parent.resultSummary,
    auto: true,
  });
  return parent.id;
}

export function claimTicket(ticketId, agentId, agentName, profileId?) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (ticket.status !== "backlog" && ticket.status !== "rework") {
    return { error: `cannot claim ticket in status: ${ticket.status}` };
  }

  // Dependency gate — a ticket is only claimable once every blockedBy
  // dependency has reached a terminal status. This is what makes ordered
  // execution a guarantee rather than convention.
  const openBlockers = getOpenBlockers(ticket);
  if (openBlockers.length > 0) {
    return {
      error: `ticket blocked by ${openBlockers.length} open ${openBlockers.length === 1 ? "dependency" : "dependencies"}: ${openBlockers.join(", ")}`,
      blockedBy: openBlockers,
    };
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

// Returns claimable tickets (backlog/rework with all dependencies closed),
// ordered by priority then age (oldest first). This is the dispatch order a
// caller should walk to respect the dependency graph. Read-only.
export function listReadyTickets(filter: any = {}) {
  const candidates = [
    ...ticketStore.listTickets({ status: "backlog" }),
    ...ticketStore.listTickets({ status: "rework" }),
  ];
  const ready = candidates.filter((t) => {
    if (filter.sprintId && t.sprintId !== filter.sprintId) return false;
    return getOpenBlockers(t).length === 0;
  });
  ready.sort((a, b) => {
    const ra = PRIORITY_RANK[a.priority] ?? PRIORITY_RANK.medium;
    const rb = PRIORITY_RANK[b.priority] ?? PRIORITY_RANK.medium;
    if (ra !== rb) return ra - rb;
    // Stable tie-break: oldest first, so dependency roots created earlier win.
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
  return ready;
}

// Pick the highest-priority ready ticket and claim it. Returns
// { ok: false, reason: "none_ready" } when nothing is currently dispatchable
// (everything is blocked, in-flight, or done).
//
// Ticket ops are not transactional, so select-then-claim is not atomic: under
// concurrent dispatchers two callers can select the same head. claimTicket
// re-runs both the status and dependency gates, so the loser of a race never
// bypasses them — it just fails. We walk candidates in priority order and skip
// any that another dispatcher claimed out from under us, so a lost race yields
// the next ready ticket rather than an error.
export function claimNextReady(agentId, agentName, profileId?, filter: any = {}) {
  const ready = listReadyTickets(filter);
  if (ready.length === 0) return { ok: false, reason: "none_ready" };
  for (const candidate of ready) {
    const res = claimTicket(candidate.id, agentId, agentName, profileId);
    if (res.ok) return res;
    // Lost the race (already in-progress) or deps closed in between — try next.
  }
  return { ok: false, reason: "none_ready" };
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
  // A child reaching a terminal status may complete its parent epic.
  if (newStatus === "done" || newStatus === "cancelled") {
    maybeCompleteParentEpic(ticket, updatedBy);
  }
  return { ok: true, ticket };
}

// Mark a ticket done. This is a FORCED terminal — it sets status="done" from
// ANY current status without consulting STATUS_TRANSITIONS (e.g. backlog→done,
// which updateStatus rejects). That is intentional: it is the authorized
// reconciliation path out of a stale/wrong review. When `evidence` is supplied
// ({ branch?, commitRange?, testResult?, attestedBy? }) it is recorded on the
// `completed` audit entry and folded into the ticket's workRef, so an
// orchestrator or human can attest "verified-done on branch X, tests pass"
// instead of re-entering the (possibly branch-blind) reviewer. Optional —
// existing 3-arg callers are unchanged.
export function completeTicket(ticketId, resultSummary, completedBy, evidence?) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };

  const oldStatus = ticket.status;
  ticket.status = "done";
  ticket.resultSummary = resultSummary || null;
  ticket.closedAt = new Date().toISOString();
  ticket.updatedAt = ticket.closedAt;

  const ev = evidence && typeof evidence === "object" ? evidence : null;
  if (ev && (ev.branch || ev.commitRange || ev.worktree)) {
    // Preserve any existing workRef fields the implementer recorded; attested
    // evidence wins on the keys it carries.
    ticket.workRef = {
      ...(ticket.workRef && typeof ticket.workRef === "object" ? ticket.workRef : {}),
      ...(ev.branch ? { branch: ev.branch } : {}),
      ...(ev.commitRange ? { commitRange: ev.commitRange } : {}),
      ...(ev.worktree ? { worktree: ev.worktree } : {}),
    };
  }

  addAuditEntry(ticket, "status_changed", completedBy, { from: oldStatus, to: "done" });
  addAuditEntry(ticket, "completed", completedBy, { resultSummary, evidence: ev });
  ticketStore.saveTicket(ticket);
  _bus().emit("ticket:completed", { ticketId, completedBy, resultSummary, evidence: ev });
  // Roll the closure up to the parent epic if this was the last open child.
  maybeCompleteParentEpic(ticket, completedBy);
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
const UPDATABLE_FIELDS = ["title", "description", "priority", "labels", "sprintId", "blockedBy", "type", "parentId"];

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

  // Reject blockedBy edits that would introduce a dependency cycle.
  if ("blockedBy" in fields) {
    const deps = Array.isArray(fields.blockedBy) ? fields.blockedBy : [];
    if (deps.length > 0 && wouldCreateCycle(ticketId, deps)) {
      return { error: "blockedBy would create a dependency cycle" };
    }
  }

  // Validate a re-parent: the parent must exist and the move must not make the
  // ticket its own ancestor. `null` detaches (promotes to a root/epic).
  if ("parentId" in fields && fields.parentId) {
    const parent = ticketStore.getTicket(fields.parentId);
    if (!parent) return { error: `parent ticket not found: ${fields.parentId}` };
    if (wouldCreateParentCycle(ticketId, fields.parentId)) {
      return { error: "parentId would create a hierarchy cycle" };
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

// Record a structured review verdict. This is the preferred path over the
// watcher parsing a "VERDICT:" text line out of agent output. Emits
// "ticket:verdict" which the ticket-watcher consumes to apply the
// PASS/FAIL/READY/BLOCKED state transition. Validates the kind but does NOT
// itself mutate the ticket — the watcher owns the transition so both the
// structured and legacy text paths converge on one implementation.
// INCONCLUSIVE: the reviewer inspected the tree but could not locate the work
// (e.g. it was committed on a different branch/worktree than the one checked
// out). It is NOT a failure — the watcher leaves the ticket in review rather
// than forcing it to rework. A reviewer must never assert "unimplemented" when
// it only knows "not present on the one tree I looked at".
const VALID_VERDICTS = ["PASS", "FAIL", "READY", "BLOCKED", "INCONCLUSIVE"];
export function recordVerdict(ticketId, kind, reason, reportedBy, profileLabel?) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  const normalized = String(kind || "").toUpperCase();
  if (!VALID_VERDICTS.includes(normalized)) {
    return { error: `invalid verdict: ${kind}. Must be one of: ${VALID_VERDICTS.join(", ")}` };
  }
  _bus().emit("ticket:verdict", {
    ticketId,
    kind: normalized,
    reason: reason || null,
    profileLabel: profileLabel || reportedBy || "reviewer",
    reportedBy: reportedBy || "agent",
  });
  return { ok: true, ticketId, verdict: normalized, reason: reason || null };
}

// ─── Stage-history timeline (derived, not stored) ──────────────────────────
//
// Orcanator keeps a dedicated card_stage_history table; we instead DERIVE the
// timeline from the audit trail we already record on every transition. Each
// `status_changed` audit entry carries { from, to, actor, timestamp }, so we
// can reconstruct stage durations without a second table to keep in sync. The
// result is a list of stages, each with the status entered, when, by whom, how
// it was entered (claimed/status_changed/completed/escalated/recovered), and
// the dwell time until the next transition. The final (open) stage has
// exitedAt=null and durationMs measured to `nowMs` (default: now).
//
// This intentionally trades the queryability of a real table for zero schema
// drift — the audit array is the single source of truth (ADR 0008 already
// makes audit the authoritative trail). Returns { error } for a missing ticket.
export function getTicketTimeline(ticketId, nowMs?) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  const audit = Array.isArray(ticket.audit) ? ticket.audit : [];

  // Entry actions that mark a stage boundary. `claimed`/`escalated`/`recovered`
  // are recorded alongside their status_changed, so we key off status_changed
  // for the canonical status and fold the sibling action in as `via`.
  const transitions = audit
    .filter((e) => e && e.action === "status_changed" && e.details && e.details.to)
    .map((e) => ({
      status: e.details.to,
      from: e.details.from ?? null,
      enteredAt: e.timestamp,
      actor: e.actor || "system",
    }));

  // Seed the initial stage from the `created` entry (status backlog) when the
  // first transition isn't already backlog. Gives every ticket a stage 0.
  const created = audit.find((e) => e && e.action === "created");
  const stages: any[] = [];
  if (created && (transitions.length === 0 || transitions[0].from === "backlog" || transitions[0].status !== "backlog")) {
    stages.push({ status: "backlog", from: null, enteredAt: created.timestamp, actor: created.actor || "system" });
  }
  stages.push(...transitions);

  const end = typeof nowMs === "number" ? nowMs : Date.now();
  const timeline = stages.map((s, i) => {
    const enteredMs = Date.parse(s.enteredAt);
    const next = stages[i + 1];
    const exitedAt = next ? next.enteredAt : null;
    const exitedMs = next ? Date.parse(next.enteredAt) : end;
    const durationMs = isNaN(enteredMs) ? null : Math.max(0, exitedMs - enteredMs);
    return {
      status: s.status,
      enteredAt: s.enteredAt,
      exitedAt,
      actor: s.actor,
      durationMs,
      open: !next,
    };
  });

  // Roll-up metrics the caller most often wants (cycle time, rework bounces).
  const reworkBounces = stages.filter((s) => s.status === "rework").length;
  const firstAt = stages.length ? Date.parse(stages[0].enteredAt) : NaN;
  const closedEntry = audit.find((e) => e && (e.action === "completed"));
  const closedMs = ticket.closedAt ? Date.parse(ticket.closedAt) : (closedEntry ? Date.parse(closedEntry.timestamp) : NaN);
  const totalMs = !isNaN(firstAt) ? Math.max(0, (isNaN(closedMs) ? end : closedMs) - firstAt) : null;

  return {
    ok: true,
    ticketId,
    currentStatus: ticket.status,
    stages: timeline,
    reworkBounces,
    totalMs,
  };
}

// ─── Human checkpoint (first-class pause for a human decision) ──────────────
//
// Orcanator models a human-checkpoint as a real SDLC node that pauses the
// pipeline, fires a notification, and waits for approve/reject. We had only the
// `awaiting-decision` label convention (ADR 0008 §4) with no resume primitive
// and no proactive surfacing. These two verbs make "a human must look" a
// first-class, observable state:
//
//   requestHumanCheckpoint — park the ticket (label `awaiting-decision`, which
//     the auto-implement rule already skips), record WHY, and emit
//     `ticket:needsHuman` so a surface layer (inbox, Slack, UI badge) can
//     proactively alert. Idempotent — re-parking is a no-op.
//   resolveHumanCheckpoint — a human (or trusted caller) clears the gate:
//     removes the label and, optionally, releases the ticket back to a status
//     (approve → backlog for re-dispatch, reject → cancelled). Emits
//     `ticket:humanResolved`.
//
// This is deliberately label-driven (not a new column) so it composes with the
// existing watcher skipLabels and the design-only escalation lane.
const HUMAN_GATE_LABEL = "awaiting-decision";

export function requestHumanCheckpoint(ticketId, reason, requestedBy, kind?) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (!Array.isArray(ticket.labels)) ticket.labels = [];
  if (ticket.labels.includes(HUMAN_GATE_LABEL)) {
    return { ok: true, parked: false, reason: "already_parked" };
  }
  ticket.labels.push(HUMAN_GATE_LABEL);
  ticket.updatedAt = new Date().toISOString();
  addAuditEntry(ticket, "human_checkpoint_requested", requestedBy || "system", {
    reason: reason || null,
    kind: kind || "decision",
  });
  ticketStore.saveTicket(ticket);
  _bus().emit("ticket:needsHuman", {
    ticketId,
    kind: kind || "decision",
    reason: reason || null,
    title: ticket.title,
    status: ticket.status,
    requestedBy: requestedBy || "system",
  });
  return { ok: true, parked: true };
}

export function resolveHumanCheckpoint(ticketId, resolution, resolvedBy, note?) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (!Array.isArray(ticket.labels)) ticket.labels = [];
  const had = ticket.labels.includes(HUMAN_GATE_LABEL);
  ticket.labels = ticket.labels.filter((l) => l !== HUMAN_GATE_LABEL);
  ticket.updatedAt = new Date().toISOString();
  addAuditEntry(ticket, "human_checkpoint_resolved", resolvedBy || "human", {
    resolution: resolution || "released",
    note: note || null,
  });
  ticketStore.saveTicket(ticket);

  // Optional status release. `approve` re-queues the ticket for dispatch;
  // `reject` cancels it. `release` (default) just clears the label and leaves
  // the status where it is. We route status changes through updateStatus so the
  // transition graph and audit stay authoritative — but a parked ticket may be
  // in any status, so fall back to a forced reopen-to-backlog when the graph
  // forbids the move from the current status.
  if (resolution === "approve") {
    if (ticket.status !== "backlog") {
      const res = updateStatus(ticketId, "backlog", resolvedBy || "human");
      if (res && res.error) {
        // Forbidden by the graph (e.g. in-progress→backlog is allowed, but
        // review→backlog is not). Force it: a human override is authorized.
        const fresh = ticketStore.getTicket(ticketId);
        fresh.status = "backlog";
        fresh.updatedAt = new Date().toISOString();
        addAuditEntry(fresh, "status_changed", resolvedBy || "human", { from: ticket.status, to: "backlog", forced: true });
        ticketStore.saveTicket(fresh);
        _bus().emit("ticket:statusChanged", { ticketId, oldStatus: ticket.status, newStatus: "backlog", updatedBy: resolvedBy || "human" });
      }
    }
  } else if (resolution === "reject") {
    if (ticket.status !== "cancelled") {
      const fresh = ticketStore.getTicket(ticketId);
      const old = fresh.status;
      fresh.status = "cancelled";
      fresh.closedAt = new Date().toISOString();
      fresh.updatedAt = fresh.closedAt;
      addAuditEntry(fresh, "status_changed", resolvedBy || "human", { from: old, to: "cancelled", forced: true });
      ticketStore.saveTicket(fresh);
      _bus().emit("ticket:statusChanged", { ticketId, oldStatus: old, newStatus: "cancelled", updatedBy: resolvedBy || "human" });
      maybeCompleteParentEpic(fresh, resolvedBy || "human");
    }
  }

  _bus().emit("ticket:humanResolved", {
    ticketId,
    resolution: resolution || "released",
    resolvedBy: resolvedBy || "human",
    wasParked: had,
  });
  return { ok: true, resolution: resolution || "released", wasParked: had };
}

// ─── Crash recovery (prompt path; complements the 24h sweeper) ─────────────
//
// When an agent working a ticket dies (crash, OOM, exhausted transient retries)
// the ticket is stranded in `in-progress`/`rework` until the sweeper cancels it
// 24h later. This is the PROMPT path: the watcher calls this the moment it sees
// `agent:terminated reason=errored` for a spawn it owns. We force the ticket to
// `blocked` (the transition graph forbids in-progress→blocked, but a crash IS
// the authorized exception, same rationale as completeTicket's forced done),
// record why, and raise a human checkpoint so it's surfaced — not silently
// parked. Idempotent: a ticket already terminal/blocked is left untouched.
export function recoverStuckTicket(ticketId, reason, recoveredBy) {
  const ticket = ticketStore.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  // Only recover tickets that are genuinely in-flight. A ticket that already
  // moved on (the worker DID report progress before dying, or a reviewer/human
  // already acted) must not be clobbered.
  if (ticket.status !== "in-progress" && ticket.status !== "rework") {
    return { ok: true, recovered: false, reason: "not_in_flight", status: ticket.status };
  }
  const oldStatus = ticket.status;
  ticket.status = "blocked";
  ticket.updatedAt = new Date().toISOString();
  addAuditEntry(ticket, "status_changed", recoveredBy || "ticket-watcher", { from: oldStatus, to: "blocked", forced: true });
  addAuditEntry(ticket, "recovered_stuck", recoveredBy || "ticket-watcher", { reason: reason || "agent terminated unexpectedly" });
  ticketStore.saveTicket(ticket);
  _bus().emit("ticket:statusChanged", { ticketId, oldStatus, newStatus: "blocked", updatedBy: recoveredBy || "ticket-watcher" });
  _bus().emit("ticket:recovered", { ticketId, from: oldStatus, reason: reason || null, recoveredBy: recoveredBy || "ticket-watcher" });
  // Surface for a human — a crashed worker is exactly a "someone must look" moment.
  requestHumanCheckpoint(ticketId, reason || "Agent terminated unexpectedly while working this ticket.", recoveredBy || "ticket-watcher", "recovery");
  return { ok: true, recovered: true, from: oldStatus };
}

export const listTickets = (ticketStore as any).listTickets;
export const getTicket = (ticketStore as any).getTicket;
export const deleteTicket = (ticketStore as any).deleteTicket;
export const listSprints = (ticketStore as any).listSprints;
export const getSprint = (ticketStore as any).getSprint;
export const deleteSprint = (ticketStore as any).deleteSprint;
