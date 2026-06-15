// Focused test for the member-ticket audit trail written by service.createSprint.
//
// When createSprint is given ticketIds, it backfills the bidirectional link by
// setting sprintId on each member ticket AND appending an "added_to_sprint"
// audit entry (service.ts). The existing service-sprint.test.ts only asserts
// the sprintId backfill — it never checks the audit entry, so a refactor could
// silently drop the audit trail. This pins that side-effect.
//
// All storage/bus interactions are mocked — no real FS, no real clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn(() => [...tickets.values()]),
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
  config: { ZANA_DIR: "/tmp/zana-create-sprint-audit" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedTicket(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const t = {
    id, title: "Seed ticket", description: "", status: "backlog",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null, ...overrides,
  };
  fakeDb._tickets.set(id, t);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

describe("createSprint — member-ticket audit trail", () => {
  it("records an 'added_to_sprint' audit entry on each backfilled member ticket", () => {
    const id = seedTicket();
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [id] });

    const saved = fakeDb.getTicket(id);
    const entry = saved.audit.find((a: any) => a.action === "added_to_sprint");
    expect(entry).toBeDefined();
    expect(entry.actor).toBe("system");
    expect(entry.details).toEqual({ sprintId: sprint.id });
  });

  it("does not write an audit entry for ticketIds that do not resolve to a ticket", () => {
    // A ghost id must be skipped silently — no ticket exists to audit.
    expect(() =>
      svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: ["ghost-id"] }),
    ).not.toThrow();
    // saveTicket must never run for the missing member.
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
  });
});
