// Tests for the bus emission of updateStatus() in service.ts.
//
// `ticket:statusChanged` is the trigger the review-automation pipeline
// (ticket-watcher) reacts to in order to spawn QA / architecture reviewers and
// to drive rework. service-status-transitions.test.ts pins the returned-ticket
// side-effects (reviewPhase/reworkCount/closedAt) and service.test.ts pins the
// transition guards, but nothing asserts that updateStatus actually EMITS
// `ticket:statusChanged` with the { ticketId, oldStatus, newStatus, updatedBy }
// payload — nor that the guard-rejection paths stay silent. This file closes
// that producer-side observability gap.
//
// Determinism note: the service resolves its bus lazily via
// `require("@zana-ai/core").events.bus`, which a vi.mock("@zana-ai/core")
// factory does NOT intercept. Following service-review-phase-event.test.ts and
// service-complete-event-and-guards.test.ts, we subscribe to the REAL core bus
// singleton — the exact object `_bus()` resolves — and capture emits
// synchronously. Only the db layer is faked, so there is no real FS, network,
// or clock.

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
  fakeDb._tickets.set(id, {
    id, title: "Seed", description: "", status: "backlog",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null, ...overrides,
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  captured = [];
  handler = (p: any) => captured.push(p);
  bus.on("ticket:statusChanged", handler);
});

afterEach(() => {
  bus.off("ticket:statusChanged", handler);
});

describe("updateStatus — ticket:statusChanged emission", () => {
  it("emits exactly one event carrying oldStatus, newStatus and updatedBy on a valid transition", () => {
    const id = seed({ status: "backlog" });
    const res = svc.updateStatus(id, "in-progress", "dispatcher") as any;

    expect(res.ok).toBe(true);
    expect(captured).toEqual([
      { ticketId: id, oldStatus: "backlog", newStatus: "in-progress", updatedBy: "dispatcher" },
    ]);
  });

  it("does not emit on any guard rejection (unknown ticket, invalid status, illegal transition)", () => {
    svc.updateStatus("ghost", "in-progress", "bot");              // ticket not found
    svc.updateStatus(seed(), "not-a-status" as any, "bot");        // invalid status value
    svc.updateStatus(seed({ status: "backlog" }), "done", "bot");  // illegal backlog → done

    expect(captured).toHaveLength(0);
  });
});
