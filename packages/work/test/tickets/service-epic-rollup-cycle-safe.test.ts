// Regression test for the "loop-safe" guard in maybeCompleteParentEpic
// (service.ts). The nested roll-up recurses on parent.parentId, so a corrupted
// parentId CYCLE (A→B→A) in storage could recurse forever and overflow the
// stack. The public API can't create such a cycle — updateTicket rejects it via
// wouldCreateParentCycle — but legacy/corrupted ticket files can still carry one,
// which is exactly what the terminal-status guard at the top of
// maybeCompleteParentEpic defends against:
//
//   if (parent.status === "done" || parent.status === "cancelled") return null;
//
// Once the first epic in the cycle is force-completed, re-entering it short-
// circuits, so the recursion terminates. This pins that: completing a ticket
// whose parent chain loops back on itself must NOT throw / hang, and must settle
// every ticket in the cycle to "done".
//
// Same faked-db harness as service-nested-epic-rollup.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn((filter?: any) => {
      let all = [...tickets.values()];
      if (filter?.status) all = all.filter((t) => t.status === filter.status);
      if (filter?.parentId !== undefined) {
        all = all.filter((t) => (filter.parentId === null ? !t.parentId : t.parentId === filter.parentId));
      }
      return all.map((t) => structuredClone(t));
    }),
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

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("epic auto-complete — corrupted parentId cycle is loop-safe", () => {
  it("terminates and settles both tickets to done instead of overflowing the stack", () => {
    // Well-formed tickets via the API: A is a root epic, B is its child.
    const a = svc.createTicket({ title: "epic A" }) as any;
    const b = svc.createTicket({ title: "epic B", parentId: a.id }) as any;

    // Corrupt storage directly to close the cycle (A.parentId = B). The public
    // updateTicket would reject this, so we bypass it — modelling a legacy/
    // hand-edited ticket file. Now A↔B are each other's parent AND child.
    const storedA = fakeDb._tickets.get(a.id);
    storedA.parentId = b.id;

    // Completing B rolls up to A; A's roll-up recurses back toward B, which the
    // terminal-status guard must stop. A blown guard would RangeError here.
    let result: any;
    expect(() => { result = svc.completeTicket(b.id, "done B", "tester"); }).not.toThrow();

    expect(result.ok).toBe(true);
    expect(svc.getTicket(b.id).status).toBe("done");
    expect(svc.getTicket(a.id).status).toBe("done"); // rolled up exactly once

    // The roll-up fired for A exactly once — a single epic_auto_completed entry,
    // proving the recursion did not re-process an already-terminal node.
    const autoEntries = svc.getTicket(a.id).audit.filter(
      (e: any) => e.action === "epic_auto_completed",
    );
    expect(autoEntries).toHaveLength(1);
  });
});
