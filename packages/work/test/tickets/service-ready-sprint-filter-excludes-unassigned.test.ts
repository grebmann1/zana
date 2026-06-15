// Pins an untested branch of listReadyTickets in service.ts:
//   if (filter.sprintId && t.sprintId !== filter.sprintId) return false;
// When a sprintId filter is supplied, a ready ticket with NO sprint
// (sprintId: null) must be excluded — `null !== "S1"` is true. The existing
// service-dependency-ordering.test.ts only contrasts two assigned sprints
// (S1 vs S2) and never exercises the unassigned-ticket case.
//
// All I/O mocked; deterministic, no real Claude/network.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn((filter?: any) => {
      let all = [...tickets.values()];
      if (filter?.status) all = all.filter(t => t.status === filter.status);
      if (filter?.sprintId) all = all.filter(t => t.sprintId === filter.sprintId);
      return all.map((t) => structuredClone(t));
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
  config: { ZANA_DIR: "/tmp/zana-ready-sprint-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

let seq = 0;
function seedTicket(overrides: Record<string, any> = {}) {
  seq += 1;
  const id = overrides.id || `T-${seq}`;
  const createdAt = overrides.createdAt || `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`;
  const ticket = {
    id,
    title: `Ticket ${id}`,
    status: "backlog",
    priority: "medium",
    sprintId: null,
    blockedBy: [],
    audit: [],
    createdBy: "test",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
  fakeDb._tickets.set(id, ticket);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
  seq = 0;
});

describe("listReadyTickets — sprint filter excludes unassigned tickets", () => {
  it("drops a ready ticket with no sprintId when a sprintId filter is given", () => {
    seedTicket({ id: "in-sprint", sprintId: "S1" });
    seedTicket({ id: "no-sprint", sprintId: null });
    const ready = svc.listReadyTickets({ sprintId: "S1" });
    expect(ready.map((t: any) => t.id)).toEqual(["in-sprint"]);
  });

  it("returns the unassigned ticket when no sprint filter is given", () => {
    seedTicket({ id: "in-sprint", sprintId: "S1" });
    seedTicket({ id: "no-sprint", sprintId: null });
    const ready = svc.listReadyTickets();
    expect(ready.map((t: any) => t.id).sort()).toEqual(["in-sprint", "no-sprint"]);
  });
});
