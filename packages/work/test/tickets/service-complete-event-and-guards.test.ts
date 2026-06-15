// completeTicket — event emission, not-found guard, and resultSummary default.
//
// The sibling service-complete-transition-bypass.test.ts pins the forced
// state-machine bypass and the dual audit entry, but three behaviours in
// packages/work/src/tickets/service.ts completeTicket() are otherwise
// unexercised:
//
//   1. Success emits "ticket:completed" with { ticketId, completedBy,
//      resultSummary } — the contract the QA/architecture watcher pipeline
//      keys off to advance a ticket.
//   2. An unknown ticketId returns { error: "ticket not found" } and must
//      NOT save or emit anything.
//   3. An omitted resultSummary is normalized to null (the `resultSummary ||
//      null` fallback), not left undefined.
//
// Determinism note: the service resolves its bus lazily via
// `require("@zana-ai/core").events.bus`, which a vi.mock("@zana-ai/core")
// factory does NOT intercept. Following service-sprint-lifecycle-events.test.ts,
// we subscribe to the REAL core bus singleton — the exact object `_bus()`
// resolves — and capture emits synchronously. Only the db layer is faked, so
// there is no real FS, network, or clock.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as core from "@zana-ai/core";

const { fakeDb } = vi.hoisted(() => {
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
  return { fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);

import * as svc from "@zana-ai/work/src/tickets/service.ts";

const bus: any = (core as any).events.bus;

let captured: any[];
let handler: (p: any) => void;

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const t = {
    id, title: "Seed", description: "", status: "in-progress",
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
  captured = [];
  handler = (p: any) => captured.push(p);
  bus.on("ticket:completed", handler);
});

afterEach(() => {
  bus.off("ticket:completed", handler);
});

describe("completeTicket — event emission, guards, and defaults", () => {
  it("emits ticket:completed with ticketId, completedBy, and resultSummary", () => {
    const id = seed({ status: "review" });
    const res = svc.completeTicket(id, "shipped it", "agent-7") as any;

    expect(res.ok).toBe(true);
    expect(captured).toEqual([
      { ticketId: id, completedBy: "agent-7", resultSummary: "shipped it" },
    ]);
  });

  it("returns { error: 'ticket not found' } for an unknown id without saving or emitting", () => {
    const res = svc.completeTicket("ghost-id", "summary", "agent-7") as any;

    expect(res).toEqual({ error: "ticket not found" });
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it("normalizes an omitted resultSummary to null on both the ticket and the event", () => {
    const id = seed({ status: "review" });
    const res = svc.completeTicket(id, undefined, "agent-7") as any;

    expect(res.ok).toBe(true);
    expect(res.ticket.resultSummary).toBeNull();
    // The event carries the raw (undefined) summary the caller passed; the
    // persisted ticket is the source of the null normalization.
    const saved = fakeDb._tickets.get(id);
    expect(saved.resultSummary).toBeNull();
  });
});
