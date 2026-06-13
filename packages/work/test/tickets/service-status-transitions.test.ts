// Focused tests for the updateStatus() state-machine in service.ts.
//
// The main service.test.ts covers the happy path (backlog → in-progress),
// the review → rework side-effects (reworkCount, reviewPhase cleared), and
// basic guards (forbidden transition, unknown status, unknown ticketId).
//
// Three branches remain untested:
//
//   1. Transitioning to "cancelled" sets closedAt.
//      src line 126: `if (newStatus === "done" || newStatus === "cancelled")`
//      The `|| "cancelled"` operand has never been exercised in tests.
//
//   2. "done → backlog" re-open.
//      STATUS_TRANSITIONS carries "done": ["backlog"] but no test exercises it.
//
//   3. reviewPhase is NOT overwritten when a ticket already has one and
//      transitions to "review" again.
//      src line 129: `if (newStatus === "review" && !ticket.reviewPhase)`
//      Only fires on the first arrival at "review"; a second arrival (e.g.
//      review → in-progress → review) must leave the existing phase intact.
//
// All I/O and event-bus interactions are mocked — no real FS, no real clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) =>
      tickets.has(id) ? structuredClone(tickets.get(id)) : null,
    ),
    listTickets: vi.fn(() => [...tickets.values()]),
    deleteTicket: vi.fn((id: string) => { tickets.delete(id); }),
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
  config: { ZANA_DIR: "/tmp/zana-status-test" },
  project: {
    workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" },
  },
  util: {
    logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
  },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const ticket = {
    id,
    title: "Seed",
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
    createdAt: now,
    updatedAt: now,
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
});

// ── 1. Transitioning to "cancelled" sets closedAt ────────────────────────────

describe("updateStatus — transitioning to 'cancelled' sets closedAt", () => {
  it("sets closedAt on the returned ticket when status transitions to cancelled", () => {
    const id = seed({ status: "in-progress" });
    const result = svc.updateStatus(id, "cancelled", "actor") as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.status).toBe("cancelled");
    // closedAt must be a valid ISO timestamp — not null.
    expect(result.ticket.closedAt).not.toBeNull();
    expect(() => new Date(result.ticket.closedAt)).not.toThrow();
  });

  it("persists closedAt to the store when transitioning to cancelled", () => {
    const id = seed({ status: "in-progress" });
    svc.updateStatus(id, "cancelled", "actor");

    const saved = fakeDb._tickets.get(id);
    expect(saved.closedAt).not.toBeNull();
  });

});

// ── 2. "done → backlog" re-open ───────────────────────────────────────────────

describe("updateStatus — 'done → backlog' re-opens a completed ticket", () => {
  it("allows the done → backlog transition and clears the done state", () => {
    // Seed a ticket that is already done (closedAt set).
    const closedAt = new Date().toISOString();
    const id = seed({ status: "done", closedAt });

    const result = svc.updateStatus(id, "backlog", "actor") as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.status).toBe("backlog");
  });

  it("does NOT set closedAt again when re-opening from done to backlog", () => {
    // closedAt is set; the re-open transition must NOT overwrite it to a new
    // value (the code only sets closedAt when newStatus is "done" or "cancelled").
    const closedAt = "2026-01-01T00:00:00.000Z";
    const id = seed({ status: "done", closedAt });

    const result = svc.updateStatus(id, "backlog", "actor") as any;

    // closedAt was set when it was completed; re-opening doesn't clear or reset it.
    // The value from the done transition is still in the persisted ticket.
    expect(result.ticket.closedAt).toBe(closedAt);
  });

  it("persists the re-opened ticket as backlog in the store", () => {
    const id = seed({ status: "done", closedAt: new Date().toISOString() });
    svc.updateStatus(id, "backlog", "actor");

    const saved = fakeDb._tickets.get(id);
    expect(saved.status).toBe("backlog");
  });
});

// ── 3. reviewPhase is NOT overwritten on a second arrival at "review" ─────────

describe("updateStatus — existing reviewPhase is preserved when ticket returns to review", () => {
  it("does not overwrite an already-set reviewPhase when transitioning to review", () => {
    // Simulate a ticket that completed one review pass (reviewPhase="architecture"),
    // dropped back to in-progress, and is now returning to review.  The guard
    // `if (newStatus === "review" && !ticket.reviewPhase)` must not fire because
    // reviewPhase is already set.
    const id = seed({ status: "in-progress", reviewPhase: "architecture" });

    const result = svc.updateStatus(id, "review", "actor") as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.reviewPhase).toBe("architecture");
  });

  it("sets reviewPhase to 'qa' only when it is null on first arrival at review", () => {
    // Sanity-check that the happy-path still fires when reviewPhase is null.
    const id = seed({ status: "in-progress", reviewPhase: null });

    const result = svc.updateStatus(id, "review", "actor") as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.reviewPhase).toBe("qa");
  });
});
