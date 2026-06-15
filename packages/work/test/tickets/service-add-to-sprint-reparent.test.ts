// addTicketToSprint — re-parenting + event/audit emission.
//
// packages/work/src/tickets/service.ts addTicketToSprint():
//   - overwrites ticket.sprintId with the NEW sprint id
//   - appends the ticket to the new sprint's ticketIds
//   - emits "ticket:updated" with fields:["sprintId"], updatedBy:"system"
//   - records an audit entry action="updated", actor="system"
//
// The existing service-sprint.test.ts covers link/idempotent/error/persist
// but NOT (a) the bus event + audit side-effects, and NOT (b) the cross-sprint
// move semantics. Crucially, moving a ticket from sprint A to sprint B rewrites
// the ticket's sprintId to B but does NOT remove it from A's ticketIds — A keeps
// a dangling reference. This file pins that real, currently-unpinned behavior so
// a future refactor can't silently change it without a failing test.
//
// All I/O is mocked — no real FS, no real bus, no real clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn((filter?: any) => {
      const all = [...tickets.values()];
      if (!filter) return all;
      return all.filter((t) => !filter.sprintId || t.sprintId === filter.sprintId);
    }),
    deleteTicket: vi.fn((id: string) => { tickets.delete(id); }),
    saveSprint: vi.fn((s: any) => { sprints.set(s.id, structuredClone(s)); }),
    getSprint: vi.fn((id: string) => sprints.has(id) ? structuredClone(sprints.get(id)) : null),
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
  config: { ZANA_DIR: "/tmp/zana-add-to-sprint-reparent" },
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

// NOTE on the event bus: service.ts emits via _bus() => require("@zana-ai/core").events.bus,
// which resolves the real module at call time rather than the vi.mock, so a positive
// fakeBus.emit assertion cannot be captured (see service-create-audit.test.ts). We pin the
// audit entry instead — it is fully observable on the persisted record.
describe("addTicketToSprint — audit side-effect", () => {
  it("records an audit entry action=updated actor=system for the sprintId change", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    const ticketId = seedTicket();

    svc.addTicketToSprint(ticketId, sprint.id);

    const saved = fakeDb.getTicket(ticketId);
    const entry = saved.audit.find((a: any) => a.action === "updated");
    expect(entry).toBeDefined();
    expect(entry.actor).toBe("system");
    expect(entry.details.fields).toEqual(["sprintId"]);
  });
});

describe("addTicketToSprint — cross-sprint re-parenting", () => {
  it("overwrites the ticket's sprintId to the new sprint", () => {
    const a = svc.createSprint({ name: "A", teamId: null, daemonId: null, ticketIds: [] });
    const b = svc.createSprint({ name: "B", teamId: null, daemonId: null, ticketIds: [] });
    const ticketId = seedTicket();

    svc.addTicketToSprint(ticketId, a.id);
    svc.addTicketToSprint(ticketId, b.id);

    expect(fakeDb.getTicket(ticketId).sprintId).toBe(b.id);
  });

  it("adds the ticket to the new sprint while leaving a dangling reference in the old one", () => {
    // Current behavior: re-parenting does NOT unlink from the old sprint, so the
    // old sprint keeps the ticketId. Pin this so the no-cleanup behavior is
    // explicit and any future bidirectional-cleanup change is a deliberate edit.
    const a = svc.createSprint({ name: "A", teamId: null, daemonId: null, ticketIds: [] });
    const b = svc.createSprint({ name: "B", teamId: null, daemonId: null, ticketIds: [] });
    const ticketId = seedTicket();

    svc.addTicketToSprint(ticketId, a.id);
    svc.addTicketToSprint(ticketId, b.id);

    expect(fakeDb.getSprint(b.id).ticketIds).toContain(ticketId);
    expect(fakeDb.getSprint(a.id).ticketIds).toContain(ticketId);
  });
});
