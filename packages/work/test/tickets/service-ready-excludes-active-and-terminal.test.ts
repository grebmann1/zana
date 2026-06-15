// Pins a dispatch invariant in service.ts complementary to
// service-ready-excludes-blocked-status.test.ts: listReadyTickets (and thus
// claimNextReady) builds its candidate set from ONLY two queries —
// { status: "backlog" } and { status: "rework" } (service.ts lines 183-186).
//
// That means a ticket in any OTHER status must never be dispatchable:
//   - "in-progress" (already claimed by another agent),
//   - "review"      (awaiting a reviewer),
//   - "done"        (finished),
//   - "cancelled"   (abandoned).
//
// None of these have an open-dependency reason to be excluded — a done ticket
// with no blockedBy would sail through the dependency gate. Only the candidate
// status query keeps them out. If a regression widened that query (or swapped
// the underlying listTickets call), a worker could be re-spawned on an
// in-flight or already-finished ticket. The existing suite pins "blocked" but
// nothing pins the active/terminal statuses, so this file does.
//
// All I/O mocked. The fake db honors the `status` filter, matching the real
// store the ready selector relies on.

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
  config: { ZANA_DIR: "/tmp/zana-ready-active-terminal-test" },
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

describe("listReadyTickets — only backlog and rework are dispatchable", () => {
  // Each non-candidate status is seeded with zero open dependencies, so the
  // dependency gate alone would never exclude it — the candidate query must.
  for (const status of ["in-progress", "review", "done", "cancelled"]) {
    it(`omits a '${status}' ticket even with no open dependency blockers`, () => {
      seedTicket({ id: "OUT", status, blockedBy: [] });
      const ready = svc.listReadyTickets();
      expect(ready.map((t: any) => t.id)).toEqual([]);
    });
  }

  it("dispatches only the backlog and rework peers among a mixed-status set", () => {
    seedTicket({ id: "GO-backlog", status: "backlog" });
    seedTicket({ id: "GO-rework", status: "rework" });
    seedTicket({ id: "SKIP-inprogress", status: "in-progress" });
    seedTicket({ id: "SKIP-review", status: "review" });
    seedTicket({ id: "SKIP-done", status: "done" });
    seedTicket({ id: "SKIP-cancelled", status: "cancelled" });

    const ready = svc.listReadyTickets();
    expect(ready.map((t: any) => t.id).sort()).toEqual(["GO-backlog", "GO-rework"]);
  });
});

describe("claimNextReady — never claims an active or terminal ticket", () => {
  it("returns none_ready when every ticket is in-progress / done / cancelled", () => {
    seedTicket({ id: "A", status: "in-progress" });
    seedTicket({ id: "B", status: "done" });
    seedTicket({ id: "C", status: "cancelled" });

    const res = svc.claimNextReady("agent-1", "Agent One") as any;
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("none_ready");

    // None of the non-candidate tickets were mutated by the failed dispatch.
    expect(svc.getTicket("A").assigneeId).toBeNull();
    expect(svc.getTicket("A").status).toBe("in-progress");
    expect(svc.getTicket("B").status).toBe("done");
    expect(svc.getTicket("C").status).toBe("cancelled");
  });
});
