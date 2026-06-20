// Focused test for the epic roll-up that fires from the REJECT branch of
// resolveHumanCheckpoint (service.ts ~L839).
//
// resolveHumanCheckpoint("reject") force-cancels the parked ticket and then
// calls maybeCompleteParentEpic(fresh, ...). The existing epic-rollup suite
// only drives auto-completion through completeTicket / updateStatus, and the
// reject suite (service-resolve-reject-cancels) uses a parentId-less ticket —
// so the "rejecting an epic's LAST open child auto-completes the parent epic"
// interaction is exercised by nothing. A regression that dropped the
// maybeCompleteParentEpic call from the reject path (leaving the epic stranded
// open forever — the ghost-epic problem ADR 0011 set out to kill) would pass
// every existing test. This pins it.
//
// db is faked (no real FS, no real clock); the listTickets fake honours the
// parentId filter so getChildren resolves correctly. `@zana-ai/core` is NOT
// mocked, so the service emits on the same real singleton bus we listen on
// (mirrors the sibling reject test).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
const bus: any = (require("@zana-ai/core") as any).events.bus;

let completed: any[];
const onCompleted = (p: any) => completed.push(p);

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  completed = [];
  bus.on("ticket:completed", onCompleted);
});

afterEach(() => {
  bus.off("ticket:completed", onCompleted);
});

describe("resolveHumanCheckpoint — reject rolls up the parent epic", () => {
  it("auto-completes the parent epic when reject cancels its last open child", () => {
    const epic = svc.createTicket({ title: "epic" }) as any;
    const child = svc.createTicket({ title: "child", parentId: epic.id }) as any;

    // Park the only child on a human checkpoint, then reject it.
    svc.requestHumanCheckpoint(child.id, "scope dropped", "agent");
    const res = svc.resolveHumanCheckpoint(child.id, "reject", "alice", "won't fix") as any;
    expect(res).toMatchObject({ ok: true, resolution: "reject", wasParked: true });

    // The rejected child is force-cancelled.
    expect(svc.getTicket(child.id).status).toBe("cancelled");

    // Its parent epic — the child was the last open one — auto-completes to done.
    const parent = svc.getTicket(epic.id);
    expect(parent.status).toBe("done");
    expect(parent.resultSummary).toBe(
      "Auto-completed: all 1 child tickets resolved (0 done, 1 cancelled).",
    );

    // The roll-up audit entry carries the structured counts.
    const auto = parent.audit.find((e: any) => e.action === "epic_auto_completed");
    expect(auto).toBeDefined();
    expect(auto.details).toMatchObject({ childCount: 1, doneCount: 0 });

    // The epic completion is surfaced on the bus as an auto-completion.
    const epicCompleted = completed.filter((p) => p.ticketId === epic.id);
    expect(epicCompleted).toHaveLength(1);
    expect(epicCompleted[0]).toMatchObject({ auto: true });
  });
});
