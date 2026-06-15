// Covers the sprint-scoping path in claimNextReady (service.ts): when called
// with a { sprintId } filter, it must dispatch ONLY tickets belonging to that
// sprint, even when a higher-priority ready ticket exists in another sprint.
//
// listReadyTickets' sprint filter is exercised in isolation elsewhere; this
// drives the integration through claimNextReady, asserting the filter is
// forwarded so a cross-sprint ticket is never claimed out of scope.
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
  config: { ZANA_DIR: "/tmp/zana-claim-sprint-test" },
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

describe("claimNextReady — sprint filter scoping", () => {
  it("claims only tickets in the requested sprint, ignoring a higher-priority ticket in another sprint", () => {
    // Highest priority overall, but in a DIFFERENT sprint — must not be claimed.
    seedTicket({ id: "other-sprint-critical", priority: "critical", sprintId: "sprint-B" });
    // Lower priority, but in the requested sprint — this is the only valid pick.
    seedTicket({ id: "target-sprint-low", priority: "low", sprintId: "sprint-A" });

    const res = svc.claimNextReady("agent-1", "Agent One", undefined, { sprintId: "sprint-A" });

    expect(res.ok).toBe(true);
    expect(res.ticket.id).toBe("target-sprint-low");
    expect(res.ticket.assigneeId).toBe("agent-1");

    // The out-of-scope ticket is left untouched.
    const savedIds = fakeDb.saveTicket.mock.calls.map((c) => c[0].id);
    expect(savedIds).toEqual(["target-sprint-low"]);
    expect(savedIds).not.toContain("other-sprint-critical");
    expect(fakeDb._tickets.get("other-sprint-critical").status).toBe("backlog");
    expect(fakeDb._tickets.get("other-sprint-critical").assigneeId).toBe(null);
  });

  it("returns none_ready when the requested sprint has no ready tickets, even though other sprints do", () => {
    seedTicket({ id: "elsewhere", priority: "high", sprintId: "sprint-B" });

    const res = svc.claimNextReady("agent-1", "Agent One", undefined, { sprintId: "sprint-A" });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("none_ready");
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
    expect(fakeDb._tickets.get("elsewhere").status).toBe("backlog");
  });
});
