// Covers the sequential multi-worker drain of claimNextReady (service.ts):
// when several workers each call claimNextReady in turn against the SAME store
// (no mocked race), each must receive the next-highest-priority ready ticket,
// the previously claimed ticket must no longer be dispatchable (it moved to
// in-progress), and once every ticket is claimed the next call returns
// none_ready.
//
// The sibling suites assert a single head-claim (priority-head) and the
// race-recovery branches (skip-lost, all-lost) by mocking listTickets. None of
// them drive the plain "two+ workers drain the backlog in priority order, one
// distinct ticket each" invariant end-to-end through the store — that is the
// real dispatch guarantee, and this drives it.
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
  config: { ZANA_DIR: "/tmp/zana-claim-sequential-drain-test" },
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

describe("claimNextReady — sequential multi-worker drain", () => {
  it("hands each worker the next-highest-priority ticket and reports none_ready once drained", () => {
    seedTicket({ id: "crit", priority: "critical" });
    seedTicket({ id: "high", priority: "high" });
    seedTicket({ id: "med", priority: "medium" });

    // Three workers pull in turn against the same store — no mocked race.
    const r1 = svc.claimNextReady("agent-1", "Agent One");
    const r2 = svc.claimNextReady("agent-2", "Agent Two");
    const r3 = svc.claimNextReady("agent-3", "Agent Three");

    // Each worker gets a DISTINCT ticket in strict priority order.
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    expect([r1.ticket.id, r2.ticket.id, r3.ticket.id]).toEqual(["crit", "high", "med"]);

    // Each claimed ticket records the claiming worker and is now in-progress —
    // proving a claimed ticket is removed from the dispatchable set.
    expect(fakeDb._tickets.get("crit")).toMatchObject({ assigneeId: "agent-1", status: "in-progress" });
    expect(fakeDb._tickets.get("high")).toMatchObject({ assigneeId: "agent-2", status: "in-progress" });
    expect(fakeDb._tickets.get("med")).toMatchObject({ assigneeId: "agent-3", status: "in-progress" });

    // Exactly three tickets were persisted — one save per successful claim,
    // each for a distinct ticket (no double-claim, no extra writes).
    const savedIds = fakeDb.saveTicket.mock.calls.map((c) => c[0].id);
    expect(savedIds).toEqual(["crit", "high", "med"]);

    // Backlog is drained — a fourth worker finds nothing dispatchable.
    const r4 = svc.claimNextReady("agent-4", "Agent Four");
    expect(r4.ok).toBe(false);
    expect(r4.reason).toBe("none_ready");
  });
});
