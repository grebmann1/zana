// Tests for the dependency-aware dispatch added to service.ts:
//   - claimTicket dependency gate (blockedBy must be done/cancelled)
//   - getOpenBlockers (missing deps treated as resolved)
//   - listReadyTickets ordering (priority then age)
//   - claimNextReady (atomic pick + claim, none_ready)
//   - cycle rejection on createTicket / updateTicket
//
// All I/O mocked. The fake db honors the `status` filter — unlike the shared
// service.test.ts fake — because the ready selector queries by status.

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
  config: { ZANA_DIR: "/tmp/zana-dep-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

let seq = 0;
function seedTicket(overrides: Record<string, any> = {}) {
  // Monotonic createdAt so age-based tie-breaks are deterministic.
  seq += 1;
  const id = overrides.id || `T-${seq}`;
  const createdAt = overrides.createdAt || `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`;
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
  seq = 0;
});

describe("getOpenBlockers", () => {
  it("returns only dependencies that are not done/cancelled", () => {
    seedTicket({ id: "A", status: "done" });
    seedTicket({ id: "B", status: "cancelled" });
    seedTicket({ id: "C", status: "in-progress" });
    const t = { blockedBy: ["A", "B", "C"] };
    expect(svc.getOpenBlockers(t)).toEqual(["C"]);
  });

  it("treats a missing dependency as resolved (not blocking)", () => {
    seedTicket({ id: "A", status: "in-progress" });
    const t = { blockedBy: ["A", "GONE"] };
    expect(svc.getOpenBlockers(t)).toEqual(["A"]);
  });

  it("returns empty for no dependencies", () => {
    expect(svc.getOpenBlockers({ blockedBy: [] })).toEqual([]);
    expect(svc.getOpenBlockers({})).toEqual([]);
  });
});

describe("claimTicket dependency gate", () => {
  it("refuses to claim a ticket with an open blocker", () => {
    seedTicket({ id: "DEP", status: "in-progress" });
    const id = seedTicket({ blockedBy: ["DEP"] });
    const res = svc.claimTicket(id, "agent-1", "Agent One");
    expect(res.ok).toBeUndefined();
    expect(res.error).toMatch(/blocked by 1 open dependency/);
    expect(res.blockedBy).toEqual(["DEP"]);
  });

  it("allows the claim once every blocker is done/cancelled", () => {
    seedTicket({ id: "D1", status: "done" });
    seedTicket({ id: "D2", status: "cancelled" });
    const id = seedTicket({ blockedBy: ["D1", "D2"] });
    const res = svc.claimTicket(id, "agent-1", "Agent One");
    expect(res.ok).toBe(true);
    expect(res.ticket.status).toBe("in-progress");
  });

  it("lists all open blockers in the error", () => {
    seedTicket({ id: "X", status: "backlog" });
    seedTicket({ id: "Y", status: "review" });
    const id = seedTicket({ blockedBy: ["X", "Y"] });
    const res = svc.claimTicket(id, "agent-1");
    expect(res.error).toMatch(/blocked by 2 open dependencies: X, Y/);
  });
});

describe("listReadyTickets", () => {
  it("excludes tickets with open blockers, includes unblocked ones", () => {
    seedTicket({ id: "ROOT", status: "backlog" });
    seedTicket({ id: "BLOCKED", status: "backlog", blockedBy: ["ROOT"] });
    const ready = svc.listReadyTickets();
    expect(ready.map((t: any) => t.id)).toEqual(["ROOT"]);
  });

  it("orders by priority then age", () => {
    seedTicket({ id: "old-medium", priority: "medium" });
    seedTicket({ id: "critical", priority: "critical" });
    seedTicket({ id: "new-medium", priority: "medium" });
    seedTicket({ id: "high", priority: "high" });
    const ready = svc.listReadyTickets();
    expect(ready.map((t: any) => t.id)).toEqual(["critical", "high", "old-medium", "new-medium"]);
  });

  it("includes rework tickets and respects sprint filter", () => {
    seedTicket({ id: "in-sprint", status: "rework", sprintId: "S1" });
    seedTicket({ id: "other-sprint", status: "backlog", sprintId: "S2" });
    const ready = svc.listReadyTickets({ sprintId: "S1" });
    expect(ready.map((t: any) => t.id)).toEqual(["in-sprint"]);
  });
});

describe("claimNextReady", () => {
  it("claims the highest-priority ready ticket", () => {
    seedTicket({ id: "low", priority: "low" });
    seedTicket({ id: "critical", priority: "critical" });
    const res = svc.claimNextReady("agent-1", "Agent One");
    expect(res.ok).toBe(true);
    expect(res.ticket.id).toBe("critical");
    expect(res.ticket.status).toBe("in-progress");
  });

  it("skips blocked tickets and picks the next ready one", () => {
    seedTicket({ id: "ROOT", status: "in-progress" });
    seedTicket({ id: "blocked-critical", priority: "critical", blockedBy: ["ROOT"] });
    seedTicket({ id: "ready-low", priority: "low" });
    const res = svc.claimNextReady("agent-1");
    expect(res.ok).toBe(true);
    expect(res.ticket.id).toBe("ready-low");
  });

  it("returns none_ready when nothing is dispatchable", () => {
    seedTicket({ id: "ROOT", status: "in-progress" });
    seedTicket({ id: "blocked", blockedBy: ["ROOT"] });
    const res = svc.claimNextReady("agent-1");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("none_ready");
  });

  it("falls through to the next candidate when the head was claimed by a racing dispatcher", () => {
    seedTicket({ id: "head", priority: "critical" });
    seedTicket({ id: "next", priority: "high" });

    // Simulate the race: listReadyTickets returns a snapshot that still shows
    // `head` as backlog, but by the time claimTicket reads it the competing
    // dispatcher has already moved it to in-progress. We mutate the stored
    // status only after the selector's snapshot is taken.
    const realList = fakeDb.listTickets.getMockImplementation()!;
    let snapshotTaken = false;
    fakeDb.listTickets.mockImplementation((filter?: any) => {
      const rows = realList(filter);
      if (!snapshotTaken) {
        snapshotTaken = true;
        fakeDb._tickets.get("head").status = "in-progress";
      }
      return rows;
    });

    const res = svc.claimNextReady("agent-2", "Agent Two");
    expect(res.ok).toBe(true);
    expect(res.ticket.id).toBe("next");
  });
});

describe("cycle rejection", () => {
  it("allows a valid blockedBy on create (no cycle)", () => {
    seedTicket({ id: "A" });
    const res = svc.createTicket({ title: "B", blockedBy: ["A"], createdBy: "t" } as any);
    expect(res.error).toBeUndefined();
    expect(res.blockedBy).toEqual(["A"]);
  });

  it("rejects a cycle introduced via updateTicket", () => {
    const a = seedTicket({ id: "A", blockedBy: [] });
    const b = seedTicket({ id: "B", blockedBy: ["A"] });
    // A depends on B, B already depends on A → cycle.
    const res = svc.updateTicket(a, { blockedBy: ["B"] }, "tester");
    expect(res.error).toMatch(/dependency cycle/);
  });

  it("allows a non-cyclic dependency chain via update", () => {
    const a = seedTicket({ id: "A" });
    const b = seedTicket({ id: "B" });
    const res = svc.updateTicket(b, { blockedBy: ["A"] }, "tester");
    expect(res.error).toBeUndefined();
    expect(res.ticket.blockedBy).toEqual(["A"]);
  });

  it("rejects a direct self-reference (ticket blockedBy itself)", () => {
    // service.ts documents that wouldCreateCycle catches "a direct
    // self-reference" — A pointing its own blockedBy at A. The walk hits
    // `cur === ticketId` on the first pop, before any graph traversal.
    const a = seedTicket({ id: "A", blockedBy: [] });
    const res = svc.updateTicket(a, { blockedBy: ["A"] }, "tester");
    expect(res.error).toMatch(/dependency cycle/);
    // The self-referential edit must not be persisted.
    expect(svc.getTicket("A").blockedBy).toEqual([]);
  });

  it("rejects a transitive multi-hop cycle via update", () => {
    // Chain A → B → C (A blocked by B, B blocked by C). Pointing C at A closes
    // the loop A → B → C → A. This exercises the graph walk in
    // wouldCreateCycle, not just the direct-edge check.
    seedTicket({ id: "A", blockedBy: ["B"] });
    seedTicket({ id: "B", blockedBy: ["C"] });
    const c = seedTicket({ id: "C", blockedBy: [] });

    const res = svc.updateTicket(c, { blockedBy: ["A"] }, "tester");
    expect(res.error).toMatch(/dependency cycle/);
    // The rejected edit must not be persisted.
    expect(svc.getTicket("C").blockedBy).toEqual([]);
  });

  it("terminates and allows the edit when the graph has a pre-existing cycle not involving the updated ticket", () => {
    // X ↔ Y form a cycle that does NOT include Z. Pointing Z at X must be
    // allowed (no loop closes through Z) and, critically, the walk must
    // terminate — the `visited` guard in wouldCreateCycle is the only thing
    // stopping the X → Y → X traversal from looping forever. Without it this
    // test would hang until vitest's per-test timeout fires.
    seedTicket({ id: "X", blockedBy: ["Y"] });
    seedTicket({ id: "Y", blockedBy: ["X"] });
    const z = seedTicket({ id: "Z", blockedBy: [] });

    const res = svc.updateTicket(z, { blockedBy: ["X"] }, "tester");
    expect(res.error).toBeUndefined();
    expect(svc.getTicket("Z").blockedBy).toEqual(["X"]);
  });
});
