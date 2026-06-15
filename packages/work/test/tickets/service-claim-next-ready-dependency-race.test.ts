// Covers the in-loop fall-through path in claimNextReady (service.ts) when the
// head candidate fails the DEPENDENCY gate — not the status gate — mid-loop.
//
// The sibling race suites (service-claim-next-ready-skip-lost / -all-lost) only
// simulate a competing dispatcher flipping a candidate to "in-progress", so the
// loop's claimTicket fails on the *status* gate. claimNextReady's comment also
// promises resilience when "deps closed in between" — i.e. a blocker that
// re-opens after listReadyTickets took its snapshot. That makes claimTicket
// fail on the *dependency* gate instead, a distinct branch. This pins it: a
// blocker reopening between selection and claim must skip the head and claim
// the next ready ticket, never bypass the gate or error out.
//
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
  config: { ZANA_DIR: "/tmp/zana-claim-dep-race-test" },
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

describe("claimNextReady — head's dependency reopens mid-loop", () => {
  it("skips a candidate that fails the dependency gate after selection and claims the next ready ticket", () => {
    // BLOCKER starts done, so the head is selected as ready. "next" is an
    // independent, unblocked, lower-priority ticket.
    seedTicket({ id: "BLOCKER", status: "done" });
    seedTicket({ id: "head", priority: "critical", blockedBy: ["BLOCKER"] });
    seedTicket({ id: "next", priority: "high" });

    // listReadyTickets reads BLOCKER once (computing head's open blockers) and
    // sees it done → head is ready. We reopen BLOCKER on the SECOND read, which
    // is the dependency-gate re-check inside claimTicket(head). The head then
    // fails the gate and claimNextReady must fall through to "next".
    let blockerReads = 0;
    const stored = fakeDb._tickets;
    fakeDb.getTicket.mockImplementation((id: string) => {
      if (id === "BLOCKER") {
        blockerReads += 1;
        if (blockerReads >= 2) stored.get("BLOCKER").status = "in-progress";
      }
      return stored.has(id) ? structuredClone(stored.get(id)) : null;
    });

    const res = svc.claimNextReady("agent-1", "Agent One");

    // The head is skipped on the dependency gate; "next" is claimed instead.
    expect(res.ok).toBe(true);
    expect(res.ticket.id).toBe("next");
    expect(res.ticket.status).toBe("in-progress");
    expect(res.ticket.assigneeId).toBe("agent-1");

    // Exactly one ticket persisted — never the gated head.
    const savedIds = fakeDb.saveTicket.mock.calls.map((c) => c[0].id);
    expect(savedIds).toEqual(["next"]);
    expect(savedIds).not.toContain("head");

    // The head was never claimed: still backlog, unassigned.
    expect(stored.get("head").status).toBe("backlog");
    expect(stored.get("head").assigneeId).toBe(null);
  });
});
