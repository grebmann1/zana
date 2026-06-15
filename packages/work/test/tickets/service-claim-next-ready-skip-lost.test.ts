// Covers the in-loop skip path in claimNextReady (service.ts): when the FIRST
// (highest-priority) ready candidate is claimed out from under us by a racing
// dispatcher, the loop must skip it and claim the NEXT ready ticket rather than
// erroring or returning none_ready.
//
// The sibling suite (service-claim-next-ready-all-lost) exercises the case where
// EVERY candidate is lost. This drives the distinct branch where some — but not
// all — candidates are lost, which is the resilience guarantee that a lost race
// yields the next ready ticket instead of a failure.
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
  config: { ZANA_DIR: "/tmp/zana-claim-skip-test" },
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

describe("claimNextReady — first candidate lost to a race", () => {
  it("skips the lost head and claims the next ready ticket in priority order", () => {
    seedTicket({ id: "head", priority: "critical" });
    seedTicket({ id: "next", priority: "high" });

    // After listReadyTickets takes its snapshot (both backlog), a racing
    // dispatcher claims ONLY the head. The loop tries head first → reads
    // in-progress → fails the status gate → falls through to claim "next".
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

    const res = svc.claimNextReady("agent-1", "Agent One");

    // The lost head is skipped; the next ready ticket is claimed instead.
    expect(res.ok).toBe(true);
    expect(res.ticket.id).toBe("next");
    expect(res.ticket.status).toBe("in-progress");
    expect(res.ticket.assigneeId).toBe("agent-1");

    // Exactly one ticket was persisted — the surviving "next", never the head
    // that was already claimed out from under us.
    const savedIds = fakeDb.saveTicket.mock.calls.map((c) => c[0].id);
    expect(savedIds).toEqual(["next"]);
    expect(savedIds).not.toContain("head");
    // The head is left exactly as the racing dispatcher set it.
    expect(fakeDb._tickets.get("head").status).toBe("in-progress");
    expect(fakeDb._tickets.get("head").assigneeId).toBe(null);
  });
});
