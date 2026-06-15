// completeTicket — audit/event divergence: a `status_changed` AUDIT entry is
// written, but the ONLY bus event emitted is `ticket:completed`.
//
// packages/work/src/tickets/service.ts completeTicket() (lines ~252-267):
//   addAuditEntry(ticket, "status_changed", completedBy, { from, to: "done" });
//   addAuditEntry(ticket, "completed", completedBy, { resultSummary });
//   _bus().emit("ticket:completed", { ... });   // ← the ONLY emit
//
// Note there is no `_bus().emit("ticket:statusChanged", ...)` — unlike
// updateStatus(), which emits exactly that. This divergence is load-bearing:
// the review-automation watcher (tickets/watcher.ts) reacts to BOTH
// `ticket:statusChanged` and `ticket:completed`. If a refactor "helpfully"
// made completeTicket also emit `ticket:statusChanged` (to match its audit
// trail), the watcher would double-fire on a single completion. The sibling
// service-complete-event-and-guards.test.ts pins the presence of the
// `ticket:completed` emit but only ever subscribes to that one channel, so it
// cannot catch a spurious `ticket:statusChanged`. This file closes that gap.
//
// Determinism note: the service resolves its bus lazily via
// `require("@zana-ai/core").events.bus`, which a vi.mock("@zana-ai/core")
// factory does NOT intercept. Following service-complete-event-and-guards.test.ts,
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

let completed: any[];
let statusChanged: any[];
let onCompleted: (p: any) => void;
let onStatusChanged: (p: any) => void;

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  fakeDb._tickets.set(id, {
    id, title: "Seed", description: "", status: "review",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: "architecture", reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null, ...overrides,
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  completed = [];
  statusChanged = [];
  onCompleted = (p: any) => completed.push(p);
  onStatusChanged = (p: any) => statusChanged.push(p);
  bus.on("ticket:completed", onCompleted);
  bus.on("ticket:statusChanged", onStatusChanged);
});

afterEach(() => {
  bus.off("ticket:completed", onCompleted);
  bus.off("ticket:statusChanged", onStatusChanged);
});

describe("completeTicket — emits ticket:completed only, never ticket:statusChanged", () => {
  it("fires exactly one ticket:completed and zero ticket:statusChanged events", () => {
    const id = seed();
    const res = svc.completeTicket(id, "done and dusted", "agent-9") as any;

    expect(res.ok).toBe(true);
    expect(completed).toHaveLength(1);
    // The load-bearing assertion: no statusChanged event despite the status
    // moving review → done. updateStatus owns that channel; completeTicket
    // must not poach it, or the watcher double-fires.
    expect(statusChanged).toHaveLength(0);
  });

  it("still records a status_changed AUDIT entry even though no statusChanged event is emitted", () => {
    const id = seed({ status: "in-progress" });
    svc.completeTicket(id, null, "agent-9");

    const saved = fakeDb._tickets.get(id);
    const actions = saved.audit.map((a: any) => a.action);
    // Audit carries both transitions for traceability...
    expect(actions).toContain("status_changed");
    expect(actions).toContain("completed");
    // ...but the bus only saw the completion, never a statusChanged event.
    expect(completed).toHaveLength(1);
    expect(statusChanged).toHaveLength(0);
  });
});
