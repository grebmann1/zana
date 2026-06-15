// Focused test for the missing-dependency branch of service.wouldCreateCycle,
// reached via updateTicket.
//
// service.ts wouldCreateCycle walks the dependency graph:
//   const dep = ticketStore.getTicket(cur);
//   if (dep && Array.isArray(dep.blockedBy)) stack.push(...dep.blockedBy);
//
// Every existing cycle test (service-dependency-ordering,
// service-update-cycle-diamond-dag) only seeds blockers that EXIST. None
// exercise the `dep && …` FALSE branch — a blockedBy entry that points at a
// ticket which does not exist. updateTicket also has no separate existence
// validation on blockedBy, so the whole "dangling dependency is tolerated"
// contract rides on this branch: getTicket() returns null, the walk pushes
// nothing, the stack drains, wouldCreateCycle returns false, and the edit is
// allowed. This mirrors getOpenBlockers' "missing dep treated as resolved"
// stance — a deleted/unknown blocker must never be mistaken for a cycle.
//
// All I/O is mocked — no real FS, no real bus, deterministic.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => (tickets.has(id) ? structuredClone(tickets.get(id)) : null)),
    listTickets: vi.fn(() => [...tickets.values()]),
    deleteTicket: vi.fn(),
    saveSprint: vi.fn(),
    getSprint: vi.fn(() => null),
    listSprints: vi.fn(() => []),
    deleteSprint: vi.fn(),
    _tickets: tickets,
  };
  const fakeBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { fakeBus, fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);

vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-dangling-blocker-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedTicket(overrides: Record<string, any>) {
  const now = new Date().toISOString();
  const t = {
    title: "seed", description: "", status: "backlog", priority: "medium",
    assigneeId: null, assigneeName: null, assigneeProfileId: null,
    reviewPhase: null, reworkCount: 0, sprintId: null, labels: [],
    blockedBy: [], comments: [], audit: [], createdBy: "test",
    createdAt: now, updatedAt: now, closedAt: null, resultSummary: null,
    ...overrides,
  };
  fakeDb._tickets.set(t.id, t);
  return t.id;
}

describe("updateTicket — blockedBy pointing at a non-existent ticket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb._tickets.clear();
  });

  it("allows a dangling blocker (missing dep is not a cycle) and persists the edit", () => {
    // Z points at GHOST, which was never seeded. wouldCreateCycle pops GHOST,
    // getTicket("GHOST") → null, the `dep && …` guard is false, nothing is
    // pushed, the stack drains and the walk returns false → no cycle error.
    const z = seedTicket({ id: "Z", blockedBy: [] });

    const res: any = svc.updateTicket(z, { blockedBy: ["GHOST"] }, "tester");

    expect(res.error).toBeUndefined();
    expect(res.ticket.blockedBy).toEqual(["GHOST"]);
    // The accepted edit is persisted.
    expect(svc.getTicket("Z").blockedBy).toEqual(["GHOST"]);
  });

  it("still detects a real cycle when a real blocker is mixed with a dangling one", () => {
    // A → B (B blocked by A). Pointing A at [B, GHOST] closes A → B → A. The
    // missing GHOST must not mask the genuine loop reachable through B: the
    // walk skips GHOST but still traverses B back to A.
    const a = seedTicket({ id: "A", blockedBy: [] });
    seedTicket({ id: "B", blockedBy: ["A"] });

    const res: any = svc.updateTicket(a, { blockedBy: ["B", "GHOST"] }, "tester");

    expect(res.error).toMatch(/dependency cycle/);
    // The rejected edit must not be persisted.
    expect(svc.getTicket("A").blockedBy).toEqual([]);
  });
});
