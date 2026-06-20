// Edge-case coverage for getTicketTimeline on degenerate audit trails that the
// happy-path timeline tests (service-timeline-checkpoint-recovery.test.ts) don't
// exercise: a ticket with NO audit entries, and a stage whose `enteredAt`
// timestamp is unparseable. Both are real states for legacy/corrupt tickets and
// must degrade gracefully (no throw) rather than emit NaN durations — see the
// `isNaN` guards in service.ts (durationMs null at the parse site, totalMs null
// when there is no first stage). FS/db I/O is faked; no real FS or clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

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

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("getTicketTimeline — degenerate audit trails", () => {
  it("returns empty stages and null totalMs for a ticket with no audit entries", () => {
    fakeDb._tickets.set("E1", {
      id: "E1", title: "x", status: "backlog",
      labels: [], blockedBy: [], comments: [], parentId: null,
      audit: [], createdAt: "2026-06-17T00:00:00.000Z", updatedAt: "2026-06-17T00:00:00.000Z", closedAt: null,
    });
    const tl = svc.getTicketTimeline("E1", Date.parse("2026-06-17T05:00:00.000Z")) as any;
    expect(tl.ok).toBe(true);
    expect(tl.stages).toEqual([]);
    expect(tl.reworkBounces).toBe(0);
    expect(tl.totalMs).toBeNull(); // no first stage → cannot compute cycle time
  });

  it("tolerates a non-array audit field without throwing", () => {
    fakeDb._tickets.set("E2", {
      id: "E2", title: "x", status: "backlog",
      labels: [], blockedBy: [], comments: [], parentId: null,
      audit: null, createdAt: "2026-06-17T00:00:00.000Z", updatedAt: "2026-06-17T00:00:00.000Z", closedAt: null,
    });
    const tl = svc.getTicketTimeline("E2") as any;
    expect(tl.ok).toBe(true);
    expect(tl.stages).toEqual([]);
  });

  it("yields durationMs=null for a stage whose enteredAt timestamp is unparseable", () => {
    const t0 = "2026-06-17T00:00:00.000Z";
    fakeDb._tickets.set("E3", {
      id: "E3", title: "x", status: "in-progress",
      labels: [], blockedBy: [], comments: [], parentId: null,
      audit: [
        { action: "created", actor: "u", timestamp: t0, details: {} },
        { action: "status_changed", actor: "u", timestamp: "not-a-real-date", details: { from: "backlog", to: "in-progress" } },
      ],
      createdAt: t0, updatedAt: t0, closedAt: null,
    });
    const tl = svc.getTicketTimeline("E3", Date.parse("2026-06-17T01:00:00.000Z")) as any;
    expect(tl.ok).toBe(true);
    const corrupt = tl.stages.find((s: any) => s.status === "in-progress");
    expect(corrupt.durationMs).toBeNull(); // unparseable enteredAt → null, not NaN
    expect(corrupt.open).toBe(true);
  });
});
