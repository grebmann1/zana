// Tests for the event emission of updateReviewPhase() in service.ts.
//
// The review automation pipeline (ticket-watcher) reacts to the
// `ticket:reviewPhaseChanged` bus event to advance a ticket from the qa
// reviewer to the architecture reviewer. service.test.ts asserts the returned
// ticket + error guards, but nothing asserts that the bus event is emitted
// with the correct { ticketId, oldPhase, newPhase, updatedBy } payload, nor
// that the error paths stay silent (no spurious event). This file closes that
// observability gap.
//
// Determinism note: the service resolves its bus lazily via
// `require("@zana-ai/core").events.bus`, which a vi.mock("@zana-ai/core")
// factory does NOT intercept. Following service-complete-event-and-guards.test.ts,
// we subscribe to the REAL core bus singleton — the exact object `_bus()`
// resolves — and capture emits synchronously. Only the db layer is faked.

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
    id, title: "Seed", description: "", status: "review",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: "qa", reworkCount: 0,
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
  bus.on("ticket:reviewPhaseChanged", handler);
});

afterEach(() => {
  bus.off("ticket:reviewPhaseChanged", handler);
});

describe("updateReviewPhase — ticket:reviewPhaseChanged emission", () => {
  it("emits exactly one event carrying oldPhase, newPhase and updatedBy", () => {
    const id = seed({ reviewPhase: "qa" });
    const res = svc.updateReviewPhase(id, "architecture", "qa-bot") as any;

    expect(res.ok).toBe(true);
    expect(captured).toEqual([
      { ticketId: id, oldPhase: "qa", newPhase: "architecture", updatedBy: "qa-bot" },
    ]);
  });

  it("does not emit on any guard rejection (unknown ticket, wrong status, invalid phase)", () => {
    svc.updateReviewPhase("ghost", "qa", "bot");                        // not found
    svc.updateReviewPhase(seed({ status: "in-progress" }), "qa", "bot"); // not in review
    svc.updateReviewPhase(seed(), "security" as any, "bot");             // invalid phase

    expect(captured).toHaveLength(0);
  });
});
