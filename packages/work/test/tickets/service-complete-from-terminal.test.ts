// completeTicket — forced terminal from an ALREADY-terminal status.
//
// service-complete-transition-bypass.test.ts pins that completeTicket forces
// "done" from non-terminal statuses (backlog/review) that updateStatus would
// reject. What it does NOT cover is the more surprising edge: completeTicket
// has no terminal-state guard at all, so calling it on a ticket that is
// already "cancelled" silently resurrects it to "done", and calling it on a
// ticket that is already "done" re-closes it. updateStatus has no
// done→done / cancelled→done transition, so this behaviour is reachable ONLY
// through completeTicket. This file pins that asymmetry and the audit trail it
// produces (from = the prior terminal status), so a future refactor that adds
// a guard has to do so deliberately rather than by accident.
//
// Behaviour is asserted through the returned ticket (as the sibling
// service-*.test.ts files do). db I/O is mocked — no real FS, no real bus.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
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
  config: { ZANA_DIR: "/tmp/zana-complete-from-terminal" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const t = {
    id, title: "Seed", description: "", status: "backlog",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null, ...overrides,
  };
  fakeDb._tickets.set(id, t);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("completeTicket — no terminal-state guard", () => {
  it("resurrects an already-cancelled ticket to done (updateStatus has no cancelled → done edge)", () => {
    // Sanity: prove the gated path genuinely refuses cancelled → done.
    const gatedId = seed({ status: "cancelled" });
    expect(svc.updateStatus(gatedId, "done", "actor").error)
      .toMatch(/cannot transition from cancelled to done/);

    // completeTicket ignores the state machine and forces the terminal status.
    const id = seed({ status: "cancelled", closedAt: new Date().toISOString() });
    const result = svc.completeTicket(id, "revived", "agent-1") as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.status).toBe("done");
    expect(result.ticket.resultSummary).toBe("revived");
    // The status_changed audit records the prior terminal status as `from`.
    const statusEntry = result.ticket.audit.find((a: any) => a.action === "status_changed");
    expect(statusEntry.details).toEqual({ from: "cancelled", to: "done" });
  });

  it("re-completes an already-done ticket, overwriting resultSummary and refreshing closedAt", () => {
    const firstClosedAt = "2020-01-01T00:00:00.000Z";
    const id = seed({ status: "done", closedAt: firstClosedAt, resultSummary: "first pass" });

    const result = svc.completeTicket(id, "second pass", "agent-2") as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.status).toBe("done");
    // resultSummary is overwritten, not preserved.
    expect(result.ticket.resultSummary).toBe("second pass");
    // closedAt is refreshed to the new completion time, not left at the original.
    expect(result.ticket.closedAt).not.toBe(firstClosedAt);
    expect(result.ticket.closedAt).toBe(result.ticket.updatedAt);
    const statusEntry = result.ticket.audit.find((a: any) => a.action === "status_changed");
    expect(statusEntry.details).toEqual({ from: "done", to: "done" });
  });
});
