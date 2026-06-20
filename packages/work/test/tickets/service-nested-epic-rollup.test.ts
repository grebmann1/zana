// Regression test for nested-epic roll-up in service.ts (maybeCompleteParentEpic).
//
// Before the fix, maybeCompleteParentEpic force-completed the DIRECT parent of
// a finished child but never recursed. In a 3-level hierarchy
// (epic → sub-epic → leaves), finishing all leaves auto-completed the sub-epic
// but left the TOP epic open forever — the exact "ghost epic" ADR 0011 §2
// claims to close. This pins the recursion: completing the last leaf must roll
// the completion all the way up.
//
// Same faked-db harness as service-epic-auto-complete-summary.test.ts.

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

describe("nested epic auto-complete — multi-level roll-up", () => {
  it("rolls completion all the way up a 3-level epic → sub-epic → leaf hierarchy", () => {
    const epic = svc.createTicket({ title: "top epic" }) as any;
    const subEpic = svc.createTicket({ title: "sub-epic", parentId: epic.id }) as any;
    const leaf1 = svc.createTicket({ title: "leaf1", parentId: subEpic.id }) as any;
    const leaf2 = svc.createTicket({ title: "leaf2", parentId: subEpic.id }) as any;

    // Finish the first leaf — sub-epic still has an open child, nothing rolls up.
    svc.completeTicket(leaf1.id, "done leaf1", "tester");
    expect(svc.getTicket(subEpic.id).status).not.toBe("done");
    expect(svc.getTicket(epic.id).status).not.toBe("done");

    // Finish the last leaf — sub-epic completes AND the top epic must follow.
    svc.completeTicket(leaf2.id, "done leaf2", "tester");

    expect(svc.getTicket(subEpic.id).status).toBe("done");
    expect(svc.getTicket(epic.id).status).toBe("done"); // the regression: was stuck open

    // Both auto-completions are attributed via audit.
    const topAuto = svc.getTicket(epic.id).audit.find((e: any) => e.action === "epic_auto_completed");
    expect(topAuto).toBeDefined();
    expect(topAuto.details.childCount).toBe(1); // the sub-epic is the only child
  });

  it("does not roll up the grandparent while a sibling sub-epic is still open", () => {
    const epic = svc.createTicket({ title: "top epic" }) as any;
    const subA = svc.createTicket({ title: "sub-A", parentId: epic.id }) as any;
    const subB = svc.createTicket({ title: "sub-B", parentId: epic.id }) as any;
    const a1 = svc.createTicket({ title: "a1", parentId: subA.id }) as any;
    svc.createTicket({ title: "b1", parentId: subB.id });

    // Completing sub-A's only leaf completes sub-A, but sub-B is still open,
    // so the top epic must stay open.
    svc.completeTicket(a1.id, "done a1", "tester");

    expect(svc.getTicket(subA.id).status).toBe("done");
    expect(svc.getTicket(subB.id).status).not.toBe("done");
    expect(svc.getTicket(epic.id).status).not.toBe("done");
  });
});
