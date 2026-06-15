// Focused test for the convergent-acyclic-DAG (diamond) case in
// service.wouldCreateCycle, reached via updateTicket.
//
// service.ts wouldCreateCycle walks the dependency graph with a `visited` set:
//   while (stack.length > 0) {
//     const cur = stack.pop();
//     if (cur === ticketId) return true;
//     if (visited.has(cur)) continue;   // ← dedup guard
//     visited.add(cur);
//     ...push dep.blockedBy...
//   }
//
// The existing suite (service-dependency-ordering.test.ts) exercises the
// `visited` guard only via a PRE-EXISTING CYCLE (X ↔ Y) — the "stop an infinite
// loop" case. It never covers a purely ACYCLIC diamond where a single node is
// legitimately reachable by two distinct paths (D below). That shape hits the
// `visited.has(cur) → continue` branch with NO cycle present, and the second
// visit must NOT be mistaken for a loop. This file pins that invariant: a
// convergent (diamond) dependency graph is allowed, and the edit is persisted.
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
  config: { ZANA_DIR: "/tmp/zana-diamond-dag-test" },
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

describe("updateTicket — convergent acyclic (diamond) dependency graph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb._tickets.clear();
  });

  it("allows pointing a ticket at two blockers that share a common dependency (no cycle)", () => {
    // Diamond:  X → A → D
    //                ↘ B ↗
    // A and B both depend on D. Pointing X at [A, B] makes D reachable by two
    // paths (X→A→D and X→B→D). The walk visits D twice; the second visit hits
    // the `visited` dedup guard. No edge closes back to X, so this is acyclic
    // and the edit must be allowed.
    seedTicket({ id: "D", blockedBy: [] });
    seedTicket({ id: "A", blockedBy: ["D"] });
    seedTicket({ id: "B", blockedBy: ["D"] });
    const x = seedTicket({ id: "X", blockedBy: [] });

    const res: any = svc.updateTicket(x, { blockedBy: ["A", "B"] }, "tester");

    expect(res.error).toBeUndefined();
    expect(res.ticket.blockedBy).toEqual(["A", "B"]);
    // The accepted edit is persisted.
    expect(svc.getTicket("X").blockedBy).toEqual(["A", "B"]);
  });

  it("still rejects a cycle that closes through one arm of the diamond", () => {
    // Same diamond, but now D depends back on X: X → A → D → X closes a loop.
    // The shared-dependency dedup must not mask this real cycle.
    seedTicket({ id: "D", blockedBy: ["X"] });
    seedTicket({ id: "A", blockedBy: ["D"] });
    seedTicket({ id: "B", blockedBy: ["D"] });
    const x = seedTicket({ id: "X", blockedBy: [] });

    const res: any = svc.updateTicket(x, { blockedBy: ["A", "B"] }, "tester");

    expect(res.error).toMatch(/dependency cycle/);
    // The rejected edit must not be persisted.
    expect(svc.getTicket("X").blockedBy).toEqual([]);
  });
});
