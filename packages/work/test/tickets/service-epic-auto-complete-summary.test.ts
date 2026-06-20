// Focused test for the epic auto-completion roll-up SUMMARY (#4, ADR 0011).
//
// The existing service-parent-epic suite proves the parent flips to "done" and
// that an epic_auto_completed audit entry is written. It does NOT pin the
// auto-generated resultSummary text or the childCount/doneCount payload that
// maybeCompleteParentEpic derives (service.ts ~L262-269). Those counts are the
// human-facing roll-up — a regression there (e.g. miscounting cancelled vs done)
// would silently lie about what the epic resolved. This locks them down.
//
// All FS/db I/O is faked — no real FS, no real clock. Auto-completion is
// asserted via the persisted audit trail (the service resolves its bus lazily
// through require("@zana-ai/core"), which a vi.mock factory does not intercept).

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

describe("epic auto-complete — roll-up summary", () => {
  it("records accurate done/cancelled counts in the summary and audit payload", () => {
    const epic = svc.createTicket({ title: "epic" }) as any;
    const c1 = svc.createTicket({ title: "c1", parentId: epic.id }) as any;
    const c2 = svc.createTicket({ title: "c2", parentId: epic.id }) as any;
    const c3 = svc.createTicket({ title: "c3", parentId: epic.id }) as any;

    // Two children finish "done", the last is "cancelled" — the cancel is what
    // closes the final open child and triggers the epic roll-up.
    svc.completeTicket(c1.id, "done c1", "tester");
    svc.completeTicket(c2.id, "done c2", "tester");
    expect(svc.getTicket(epic.id).status).not.toBe("done"); // c3 still open
    svc.updateStatus(c3.id, "cancelled", "tester");

    const parent = svc.getTicket(epic.id);
    expect(parent.status).toBe("done");

    // The generated summary reports the 3-child / 2-done / 1-cancelled split.
    expect(parent.resultSummary).toBe(
      "Auto-completed: all 3 child tickets resolved (2 done, 1 cancelled).",
    );

    // The epic_auto_completed audit entry carries the same structured counts.
    const auto = parent.audit.find((e: any) => e.action === "epic_auto_completed");
    expect(auto).toBeDefined();
    expect(auto.details.childCount).toBe(3);
    expect(auto.details.doneCount).toBe(2);
  });
});
