// End-to-end dependency lifecycle for the blockedBy edit path (ticket dc0fe56a).
//
// zana_ticket_edit (MCP) → core ticket_edit → updateTicket(ticketId, fields).
// Before dc0fe56a the MCP edit tool could not SET blockedBy at all, so a
// dependency graph could only be authored at create time. This pins the full
// flow the dispatcher cares about, exercised through the service the edit
// handler ultimately calls:
//
//   1. create A and B (no deps)
//   2. set A blockedBy B via updateTicket   ← the path the edit tool now wires
//   3. listReadyTickets EXCLUDES A while B is open
//   4. complete B → listReadyTickets INCLUDES A
//   5. attempting A→B then B→A is rejected as a cycle
//
// All I/O is mocked — no real FS, no real bus, no clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn((filter?: any) => {
      let all = [...tickets.values()];
      if (filter?.status) all = all.filter((t) => t.status === filter.status);
      if (filter?.sprintId) all = all.filter((t) => t.sprintId === filter.sprintId);
      return all.map((t) => structuredClone(t));
    }),
    deleteTicket: vi.fn((id: string) => { tickets.delete(id); }),
    saveSprint: vi.fn((s: any) => { sprints.set(s.id, structuredClone(s)); }),
    getSprint: vi.fn((id: string) => sprints.has(id) ? structuredClone(sprints.get(id)) : null),
    listSprints: vi.fn(() => [...sprints.values()]),
    deleteSprint: vi.fn((id: string) => { sprints.delete(id); }),
    _tickets: tickets,
    _sprints: sprints,
  };
  const fakeBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { fakeBus, fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);
vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-edit-blockedby" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

describe("blockedBy edit lifecycle", () => {
  it("excludes A from ready while B is open, includes it once B completes", () => {
    const a = svc.createTicket({ title: "A", createdBy: "t" } as any) as any;
    const b = svc.createTicket({ title: "B", createdBy: "t" } as any) as any;

    // Both start unblocked → both ready.
    expect(svc.listReadyTickets().map((t: any) => t.id).sort()).toEqual([a.id, b.id].sort());

    // Author the dependency via the edit path: A is blocked by B.
    const edit = svc.updateTicket(a.id, { blockedBy: [b.id] }, "editor") as any;
    expect(edit.ok).toBe(true);
    expect(edit.ticket.blockedBy).toEqual([b.id]);

    // A is now held back; only B is dispatchable.
    expect(svc.listReadyTickets().map((t: any) => t.id)).toEqual([b.id]);
    // And the dependency gate refuses a direct claim of A.
    const blocked = svc.claimTicket(a.id, "agent-1", "Agent One") as any;
    expect(blocked.error).toMatch(/blocked by 1 open dependency/);

    // Close the dependency → A becomes ready and claimable.
    svc.completeTicket(b.id, "done", "agent-2");
    expect(svc.listReadyTickets().map((t: any) => t.id)).toEqual([a.id]);
    const claimed = svc.claimTicket(a.id, "agent-1", "Agent One") as any;
    expect(claimed.ok).toBe(true);
    expect(claimed.ticket.status).toBe("in-progress");
  });

  it("treats a cancelled dependency as resolved for readiness", () => {
    const a = svc.createTicket({ title: "A", createdBy: "t" } as any) as any;
    const b = svc.createTicket({ title: "B", createdBy: "t" } as any) as any;
    svc.updateTicket(a.id, { blockedBy: [b.id] }, "editor");

    expect(svc.listReadyTickets().map((t: any) => t.id)).toEqual([b.id]);

    svc.updateStatus(b.id, "cancelled", "editor");
    expect(svc.listReadyTickets().map((t: any) => t.id)).toEqual([a.id]);
  });

  it("rejects a circular dependency authored via edit (A→B then B→A)", () => {
    const a = svc.createTicket({ title: "A", createdBy: "t" } as any) as any;
    const b = svc.createTicket({ title: "B", createdBy: "t" } as any) as any;

    // A blocked by B — fine.
    expect((svc.updateTicket(a.id, { blockedBy: [b.id] }, "editor") as any).ok).toBe(true);

    // B blocked by A would close the loop A→B→A — must be rejected.
    const cycle = svc.updateTicket(b.id, { blockedBy: [a.id] }, "editor") as any;
    expect(cycle.error).toMatch(/dependency cycle/);
    // The rejected edit must not be persisted.
    expect(svc.getTicket(b.id).blockedBy).toEqual([]);
  });
});
