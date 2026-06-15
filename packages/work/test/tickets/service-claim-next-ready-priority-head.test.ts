// Covers the base happy path of claimNextReady (service.ts): with several ready
// tickets and NO race, it must claim the single highest-priority candidate and
// leave every lower-priority ticket untouched in backlog.
//
// The sibling suites drive the race-recovery branches (skip-lost, all-lost) and
// scoping (sprint-filter, profile-forwarding). None of them assert the plain
// "pick the head by priority, claim exactly one, leave the rest" invariant that
// makes dispatch order a guarantee — this does.
// All I/O mocked — deterministic, no real db/bus.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn((filter?: any) => {
      let all = [...tickets.values()];
      if (filter?.status) all = all.filter((t) => t.status === filter.status);
      if (filter?.sprintId) all = all.filter((t) => t.sprintId === filter.sprintId);
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
  config: { ZANA_DIR: "/tmp/zana-claim-priority-head-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedTicket(overrides: Record<string, any> = {}) {
  const id = overrides.id;
  const createdAt = overrides.createdAt || "2026-01-01T00:00:00.000Z";
  const ticket = {
    id,
    title: `Ticket ${id}`,
    description: "",
    status: "backlog",
    priority: "medium",
    assigneeId: null,
    assigneeName: null,
    assigneeProfileId: null,
    reviewPhase: null,
    reworkCount: 0,
    sprintId: null,
    labels: [],
    blockedBy: [],
    comments: [],
    audit: [],
    createdBy: "test",
    createdAt,
    updatedAt: createdAt,
    closedAt: null,
    resultSummary: null,
    ...overrides,
  };
  fakeDb._tickets.set(id, ticket);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

describe("claimNextReady — highest-priority head, no race", () => {
  it("claims only the highest-priority ready ticket and leaves the rest in backlog", () => {
    // Seed out of priority order to prove the claim is driven by priority rank,
    // not insertion or id order.
    seedTicket({ id: "low-1", priority: "low" });
    seedTicket({ id: "crit", priority: "critical" });
    seedTicket({ id: "med-1", priority: "medium" });
    seedTicket({ id: "high-1", priority: "high" });

    const res = svc.claimNextReady("agent-1", "Agent One");

    // The critical ticket is the head and the one claimed.
    expect(res.ok).toBe(true);
    expect(res.ticket.id).toBe("crit");
    expect(res.ticket.status).toBe("in-progress");
    expect(res.ticket.assigneeId).toBe("agent-1");
    expect(res.ticket.assigneeName).toBe("Agent One");

    // Exactly one ticket was persisted — the head, never a lower-priority one.
    const savedIds = fakeDb.saveTicket.mock.calls.map((c) => c[0].id);
    expect(savedIds).toEqual(["crit"]);

    // Every lower-priority ticket is left untouched and still claimable.
    for (const id of ["high-1", "med-1", "low-1"]) {
      expect(fakeDb._tickets.get(id).status).toBe("backlog");
      expect(fakeDb._tickets.get(id).assigneeId).toBe(null);
    }
  });
});
