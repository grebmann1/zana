// addTicketToSprint — save asymmetry on a repeat (idempotent) call.
//
// packages/work/src/tickets/service.ts addTicketToSprint() guards only the
// sprint-membership push:
//
//   if (!sprint.ticketIds.includes(ticketId)) {
//     sprint.ticketIds.push(ticketId);
//     sprint.updatedAt = ...;
//     ticketStore.saveSprint(sprint);   // <- SKIPPED when already a member
//   }
//   ticket.sprintId = sprintId;          // <- the ticket side is UNGUARDED:
//   ticket.updatedAt = ...;              //    sprintId re-stamped,
//   addAuditEntry(ticket, "updated", ...)//    a fresh audit entry appended,
//   ticketStore.saveTicket(ticket);      //    and the ticket re-saved every call.
//
// The existing service-sprint.test.ts "is idempotent" test only asserts the
// sprint's ticketIds has no duplicate. It does NOT pin the asymmetry: a second
// identical call must NOT touch the sprint (no saveSprint) but MUST still
// re-save the ticket and grow its audit trail. This locks that contract so a
// future refactor that, say, short-circuits the whole function when the ticket
// is already a member can't silently drop the per-call audit entry.
//
// All I/O is mocked — no real FS, no real bus, no real clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => (tickets.has(id) ? structuredClone(tickets.get(id)) : null)),
    listTickets: vi.fn(() => [...tickets.values()]),
    deleteTicket: vi.fn((id: string) => { tickets.delete(id); }),
    saveSprint: vi.fn((s: any) => { sprints.set(s.id, structuredClone(s)); }),
    getSprint: vi.fn((id: string) => (sprints.has(id) ? structuredClone(sprints.get(id)) : null)),
    listSprints: vi.fn(() => [...sprints.values()]),
    deleteSprint: vi.fn((id: string) => { sprints.delete(id); }),
    _tickets: tickets,
    _sprints: sprints,
  };

  const fakeBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { fakeBus, fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);
vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-add-to-sprint-idempotent" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedTicket(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  fakeDb._tickets.set(id, {
    id, title: "Seed ticket", description: "", status: "backlog",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null, ...overrides,
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

describe("addTicketToSprint — repeat call save asymmetry", () => {
  it("skips saveSprint on the second identical call but still re-saves the ticket", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    const ticketId = seedTicket();

    // First call links the ticket — it is now a member of the sprint.
    svc.addTicketToSprint(ticketId, sprint.id);

    // Reset call counters so we observe ONLY the second (idempotent) call.
    vi.clearAllMocks();

    const result = svc.addTicketToSprint(ticketId, sprint.id) as any;

    expect(result.ok).toBe(true);
    // Membership branch is guarded: the ticket is already in ticketIds, so the
    // sprint is neither mutated nor persisted on the repeat call.
    expect(fakeDb.saveSprint).not.toHaveBeenCalled();
    // The ticket side is unguarded: it is always re-saved.
    expect(fakeDb.saveTicket).toHaveBeenCalledTimes(1);
  });

  it("appends a fresh 'updated' audit entry on every call, even when membership is unchanged", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    const ticketId = seedTicket();

    svc.addTicketToSprint(ticketId, sprint.id);
    svc.addTicketToSprint(ticketId, sprint.id);

    const saved = fakeDb.getTicket(ticketId);
    const updates = saved.audit.filter((a: any) => a.action === "updated");
    // Two calls → two audit entries, despite the sprint membership being a no-op
    // on the second call.
    expect(updates).toHaveLength(2);
    for (const entry of updates) {
      expect(entry.actor).toBe("system");
      expect(entry.details.fields).toEqual(["sprintId"]);
    }
  });
});
