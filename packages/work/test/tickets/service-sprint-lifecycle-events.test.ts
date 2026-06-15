// Locks the sprint lifecycle bus contract in packages/work/src/tickets/service.ts:
//   createSprint  → emit "sprint:created"
//   startSprint   → emit "sprint:started"  (only on a planning → active transition)
//   endSprint     → emit "sprint:ended"    (only on an active → completed transition)
//   a guard-rejected transition emits nothing.
//
// Determinism note: the service resolves its bus lazily via
// `require("@zana-ai/core").events.bus`. A `vi.mock("@zana-ai/core")` factory
// intercepts the test's *static import* but NOT the service's runtime
// `require()`, so asserting on a mocked bus is order-dependent and flaky under
// the full parallel suite. Instead we subscribe to the REAL core bus singleton
// — the exact object `_bus()` resolves — and capture emits synchronously.
// Only the storage layer is faked, so there is no real FS, network, or clock.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as core from "@zana-ai/core";

const { fakeDb } = vi.hoisted(() => {
  const sprints = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn(),
    getTicket: vi.fn(() => null),
    listTickets: vi.fn(() => []),
    deleteTicket: vi.fn(),
    saveSprint: vi.fn((s: any) => { sprints.set(s.id, structuredClone(s)); }),
    getSprint: vi.fn((id: string) => sprints.has(id) ? structuredClone(sprints.get(id)) : null),
    listSprints: vi.fn(() => [...sprints.values()]),
    deleteSprint: vi.fn((id: string) => { sprints.delete(id); }),
    _sprints: sprints,
  };
  return { fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);

import * as svc from "@zana-ai/work/src/tickets/service.ts";

const LIFECYCLE_EVENTS = ["sprint:created", "sprint:started", "sprint:ended"] as const;
const bus: any = (core as any).events.bus;

// Captured emits, keyed by event name. Listeners are attached fresh per test
// and torn down in afterEach so the shared bus singleton never leaks between
// tests.
let captured: Record<string, any[]>;
const handlers: Array<[string, (p: any) => void]> = [];

beforeEach(() => {
  fakeDb._sprints.clear();
  captured = { "sprint:created": [], "sprint:started": [], "sprint:ended": [] };
  for (const evt of LIFECYCLE_EVENTS) {
    const h = (p: any) => captured[evt].push(p);
    handlers.push([evt, h]);
    bus.on(evt, h);
  }
});

afterEach(() => {
  for (const [evt, h] of handlers) bus.off(evt, h);
  handlers.length = 0;
});

const mkSprint = () => svc.createSprint({ name: "Launch", teamId: null, daemonId: null, ticketIds: [] });

describe("sprint lifecycle bus events", () => {
  it("emits sprint:created on createSprint with sprintId and name", () => {
    const sprint = mkSprint();
    expect(captured["sprint:created"]).toEqual([{ sprintId: sprint.id, name: "Launch" }]);
  });

  it("emits sprint:started only on a successful planning → active transition", () => {
    const sprint = mkSprint();
    const res = svc.startSprint(sprint.id) as any;
    expect(res.ok).toBe(true);
    expect(captured["sprint:started"]).toEqual([{ sprintId: sprint.id, name: "Launch" }]);
  });

  it("emits sprint:ended only on a successful active → completed transition", () => {
    const sprint = mkSprint();
    svc.startSprint(sprint.id);
    const res = svc.endSprint(sprint.id) as any;
    expect(res.ok).toBe(true);
    expect(captured["sprint:ended"]).toEqual([{ sprintId: sprint.id, name: "Launch" }]);
  });

  it("does not emit a lifecycle event when the guard rejects the transition", () => {
    const sprint = mkSprint();
    // Sprint is in "planning" → endSprint must fail and emit nothing.
    const result = svc.endSprint(sprint.id) as any;
    expect(result.error).toMatch(/cannot end sprint/);
    expect(captured["sprint:started"]).toEqual([]);
    expect(captured["sprint:ended"]).toEqual([]);
  });
});
