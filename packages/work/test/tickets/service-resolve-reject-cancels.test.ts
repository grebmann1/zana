// Focused test for the REJECT branch in resolveHumanCheckpoint
// (service.ts ~829-841).
//
// `reject` is the terminal counterpart to `approve`: a human looks at a parked
// checkpoint and decides the work should not continue, so the ticket is
// force-cancelled. The transition graph forbids several →cancelled moves from a
// parked status, so the code bypasses updateStatus entirely and writes the
// cancellation directly — sets status=cancelled, stamps closedAt, records a
// `status_changed` audit entry tagged `forced: true`, and emits
// `ticket:statusChanged`. It also clears the gate label and emits
// `ticket:humanResolved` with resolution=reject.
//
// The sibling tests cover release, approve, and the forced-approve fallback but
// NEVER the reject path, so a regression that stopped cancelling (or stopped
// surfacing the cancellation) would pass every existing test. This pins it.
//
// db is faked (no real FS); `@zana-ai/core` is NOT mocked so the service emits
// on the same real singleton bus we listen on (mirrors the sibling tests).

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
let humanResolved: any[];
const onStatusChanged = (p: any) => statusChanged.push(p);
const onResolved = (p: any) => humanResolved.push(p);

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  statusChanged = [];
  humanResolved = [];
  bus.on("ticket:statusChanged", onStatusChanged);
  bus.on("ticket:humanResolved", onResolved);
});

afterEach(() => {
  bus.off("ticket:statusChanged", onStatusChanged);
  bus.off("ticket:humanResolved", onResolved);
});

describe("resolveHumanCheckpoint — reject force-cancels the ticket", () => {
  it("clears the gate, cancels with a forced audit entry, and surfaces both events", () => {
    seed("J1", "in-progress");
    svc.requestHumanCheckpoint("J1", "scope no longer needed", "agent");

    const res = svc.resolveHumanCheckpoint("J1", "reject", "alice", "won't fix") as any;
    expect(res).toMatchObject({ ok: true, resolution: "reject", wasParked: true });

    const t = svc.getTicket("J1");
    // Gate cleared and ticket cancelled.
    expect(t.labels).not.toContain("awaiting-decision");
    expect(t.status).toBe("cancelled");
    // The cancellation stamps closedAt.
    expect(typeof t.closedAt).toBe("string");
    expect(t.closedAt).not.toBeNull();

    // The forced cancellation is recorded as an authorized status_changed entry.
    const forced = t.audit.filter(
      (e: any) => e.action === "status_changed" && e.details?.forced === true,
    );
    expect(forced).toHaveLength(1);
    expect(forced[0].details).toMatchObject({ from: "in-progress", to: "cancelled", forced: true });
    expect(forced[0].actor).toBe("alice");

    // The cancellation is surfaced on the bus exactly once.
    const cancelEmit = statusChanged.filter(
      (p) => p.ticketId === "J1" && p.newStatus === "cancelled",
    );
    expect(cancelEmit).toHaveLength(1);
    expect(cancelEmit[0]).toMatchObject({ oldStatus: "in-progress", newStatus: "cancelled", updatedBy: "alice" });

    // And the resolution itself is reported.
    expect(humanResolved).toHaveLength(1);
    expect(humanResolved[0]).toMatchObject({ ticketId: "J1", resolution: "reject", resolvedBy: "alice", wasParked: true });
  });
});
