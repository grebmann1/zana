// Pins the "missing dependency is treated as resolved" dispatch invariant in
// service.ts. getOpenBlockers() walks ticket.blockedBy and, per its contract,
// DROPS any dep id that ticketStore.getTicket() can't resolve:
//
//   const dep = ticketStore.getTicket(depId);
//   if (!dep) continue;            // <- missing dep is not counted as open
//
// The documented rationale: "blocking forever on a deleted dependency would
// deadlock the dependent ticket." So a backlog ticket whose ONLY blocker has
// been deleted must be dispatchable. listReadyTickets() (and thus
// claimNextReady) derive readiness from getOpenBlockers, so the invariant must
// hold end-to-end at the dispatch layer.
//
// Sibling service-ready-*.test.ts files pin status gating, priority sort, age
// tie-break, sprint filtering and unknown-priority handling — but none pin the
// missing-dependency case. A regression that counted unknown dep ids as "open"
// (e.g. treating getTicket()===null as still-blocking) would silently strand
// every ticket whose dependency was deleted, and no existing test would catch
// it. This file does.
//
// All I/O is mocked — no real FS, no real bus, deterministic.

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
  config: { ZANA_DIR: "/tmp/zana-ready-missing-dep-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedTicket(overrides: Record<string, any> = {}) {
  const id = overrides.id || "T-x";
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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

describe("listReadyTickets — a deleted dependency does not block dispatch", () => {
  it("treats a ticket whose only blocker is missing as ready", () => {
    // GHOST is never seeded, so getTicket("GHOST") === null. The dependency
    // must be dropped, leaving zero open blockers.
    const id = seedTicket({ id: "ORPHAN", blockedBy: ["GHOST"] });

    expect(svc.getOpenBlockers(svc.getTicket(id))).toEqual([]);
    expect(svc.listReadyTickets().map((t: any) => t.id)).toEqual(["ORPHAN"]);
  });

  it("still blocks when a real open dependency coexists with a missing one", () => {
    // Only the existing, non-terminal dep counts; the ghost is dropped.
    seedTicket({ id: "OPEN-DEP", status: "in-progress" });
    seedTicket({ id: "MIXED", blockedBy: ["GHOST", "OPEN-DEP"] });

    expect(svc.getOpenBlockers(svc.getTicket("MIXED"))).toEqual(["OPEN-DEP"]);
    expect(svc.listReadyTickets().map((t: any) => t.id)).toEqual([]);
  });

  it("claimNextReady claims the orphaned ticket rather than reporting none_ready", () => {
    seedTicket({ id: "ORPHAN", blockedBy: ["GHOST"] });

    const res = svc.claimNextReady("agent-1", "Agent One") as any;

    expect(res.ok).toBe(true);
    expect(res.ticket.id).toBe("ORPHAN");
    expect(svc.getTicket("ORPHAN").status).toBe("in-progress");
    expect(svc.getTicket("ORPHAN").assigneeId).toBe("agent-1");
  });
});
