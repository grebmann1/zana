// Focused test for the FORCED-approve fallback in resolveHumanCheckpoint
// (service.ts ~818-827).
//
// `approve` re-queues a parked ticket to `backlog` via updateStatus so the
// transition graph stays authoritative. But a checkpoint can be parked from
// ANY status, and the graph forbids some →backlog moves — e.g. `review` only
// allows [done, rework, in-progress, cancelled]. When updateStatus refuses,
// the code falls back to a forced override (a human approval IS authorized):
// it sets status=backlog directly, writes a `status_changed` audit entry
// tagged `forced: true`, and emits `ticket:statusChanged`.
//
// The existing approve test seeds an `in-progress` ticket (in-progress→backlog
// is legal), so the forced branch is never taken. This pins it.
//
// db is faked (no real FS); `@zana-ai/core` is NOT mocked so the service emits
// on the same real singleton bus we listen on (mirrors the sibling event test).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn(() => [...tickets.values()].map((t) => structuredClone(t))),
    deleteTicket: vi.fn((id: string) => { tickets.delete(id); }),
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
const bus: any = (require("@zana-ai/core") as any).events.bus;

function seed(id: string, status: string) {
  const now = new Date().toISOString();
  fakeDb._tickets.set(id, {
    id, title: `ticket ${id}`, status, reviewPhase: null,
    labels: [], blockedBy: [], comments: [], audit: [], parentId: null,
    createdAt: now, updatedAt: now, closedAt: null,
  });
}

let statusChanged: any[];
const onStatusChanged = (p: any) => statusChanged.push(p);

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  statusChanged = [];
  bus.on("ticket:statusChanged", onStatusChanged);
});

afterEach(() => {
  bus.off("ticket:statusChanged", onStatusChanged);
});

describe("resolveHumanCheckpoint — forced approve from a graph-forbidden status", () => {
  it("force-moves a review-parked ticket to backlog when the graph forbids review→backlog", () => {
    seed("R1", "review");
    svc.requestHumanCheckpoint("R1", "needs sign-off", "agent");

    const res = svc.resolveHumanCheckpoint("R1", "approve", "alice") as any;
    expect(res).toMatchObject({ ok: true, resolution: "approve", wasParked: true });

    const t = svc.getTicket("R1");
    // Gate cleared and ticket re-queued despite the illegal graph transition.
    expect(t.labels).not.toContain("awaiting-decision");
    expect(t.status).toBe("backlog");

    // The forced override is recorded as an authorized status_changed entry.
    const forced = t.audit.filter(
      (e: any) => e.action === "status_changed" && e.details?.forced === true,
    );
    expect(forced).toHaveLength(1);
    expect(forced[0].details).toMatchObject({ from: "review", to: "backlog", forced: true });
    expect(forced[0].actor).toBe("alice");

    // And the forced move is surfaced on the bus exactly once.
    const forcedEmit = statusChanged.filter(
      (p) => p.ticketId === "R1" && p.newStatus === "backlog",
    );
    expect(forcedEmit).toHaveLength(1);
    expect(forcedEmit[0]).toMatchObject({ oldStatus: "review", newStatus: "backlog", updatedBy: "alice" });
  });
});
