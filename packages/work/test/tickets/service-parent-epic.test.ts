// Tests for the epic/parent hierarchy (#4): parentId on create + edit, the
// re-parent cycle guard, getChildren, and epic auto-completion when the last
// open child closes.
//
// All FS/db I/O is faked — no real FS, no real clock. Auto-completion is
// asserted via the persisted audit trail rather than the event bus: the service
// resolves its bus lazily via `require("@zana-ai/core").events.bus`, which a
// vi.mock("@zana-ai/core") factory does NOT intercept, so a faked bus would
// never capture the emit.

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

describe("createTicket — parentId", () => {
  it("rejects a parent that does not exist", () => {
    const res = svc.createTicket({ title: "child", parentId: "nope" }) as any;
    expect(res.error).toMatch(/parent ticket not found/);
  });

  it("links a child to an existing parent", () => {
    const epic = svc.createTicket({ title: "epic" }) as any;
    const child = svc.createTicket({ title: "child", parentId: epic.id }) as any;
    expect(child.parentId).toBe(epic.id);
  });
});

describe("getChildren", () => {
  it("returns only the direct children of a parent", () => {
    const epic = svc.createTicket({ title: "epic" }) as any;
    const c1 = svc.createTicket({ title: "c1", parentId: epic.id }) as any;
    const c2 = svc.createTicket({ title: "c2", parentId: epic.id }) as any;
    svc.createTicket({ title: "unrelated" });
    const kids = svc.getChildren(epic.id);
    expect(kids.map((k: any) => k.id).sort()).toEqual([c1.id, c2.id].sort());
  });
});

describe("updateTicket — re-parent cycle guard", () => {
  it("rejects making a ticket its own ancestor", () => {
    const a = svc.createTicket({ title: "a" }) as any;
    const b = svc.createTicket({ title: "b", parentId: a.id }) as any;
    // Try to make a a child of b → a→b→a cycle.
    const res = svc.updateTicket(a.id, { parentId: b.id }, "tester") as any;
    expect(res.error).toMatch(/hierarchy cycle/);
  });

  it("rejects a direct self-parent", () => {
    const a = svc.createTicket({ title: "a" }) as any;
    const res = svc.updateTicket(a.id, { parentId: a.id }, "tester") as any;
    expect(res.error).toMatch(/hierarchy cycle/);
  });

  it("allows detaching to top-level with parentId null", () => {
    const epic = svc.createTicket({ title: "epic" }) as any;
    const child = svc.createTicket({ title: "child", parentId: epic.id }) as any;
    const res = svc.updateTicket(child.id, { parentId: null }, "tester") as any;
    expect(res.ok).toBe(true);
    expect(res.ticket.parentId).toBeNull();
  });
});

describe("epic auto-complete", () => {
  it("auto-completes the parent when the last open child completes", () => {
    const epic = svc.createTicket({ title: "epic" }) as any;
    const c1 = svc.createTicket({ title: "c1", parentId: epic.id }) as any;
    const c2 = svc.createTicket({ title: "c2", parentId: epic.id }) as any;

    svc.completeTicket(c1.id, "done c1", "tester");
    expect(svc.getTicket(epic.id).status).not.toBe("done"); // c2 still open

    svc.completeTicket(c2.id, "done c2", "tester");
    const parent = svc.getTicket(epic.id);
    expect(parent.status).toBe("done");
    expect(parent.closedAt).not.toBeNull();
    // Auto-completion is recorded on the audit trail.
    expect(parent.audit.some((e: any) => e.action === "epic_auto_completed")).toBe(true);
  });

  it("counts a cancelled child as resolved", () => {
    const epic = svc.createTicket({ title: "epic" }) as any;
    const c1 = svc.createTicket({ title: "c1", parentId: epic.id }) as any;
    const c2 = svc.createTicket({ title: "c2", parentId: epic.id }) as any;
    svc.completeTicket(c1.id, "done", "tester");
    // c2 backlog → cancelled (a legal transition).
    svc.updateStatus(c2.id, "cancelled", "tester");
    expect(svc.getTicket(epic.id).status).toBe("done");
  });

  it("does not auto-complete a parent that has no children", () => {
    // A leaf ticket completing must not flip some unrelated parent.
    const leaf = svc.createTicket({ title: "leaf" }) as any;
    const res = svc.completeTicket(leaf.id, "done", "tester") as any;
    expect(res.ok).toBe(true);
  });

  it("does not re-complete an already-done parent", () => {
    const epic = svc.createTicket({ title: "epic" }) as any;
    const c1 = svc.createTicket({ title: "c1", parentId: epic.id }) as any;
    svc.completeTicket(c1.id, "done", "tester");
    expect(svc.getTicket(epic.id).status).toBe("done");
    // Re-completing the (already done) child must not re-fire the epic roll-up:
    // exactly one epic_auto_completed audit entry should ever exist.
    svc.completeTicket(c1.id, "again", "tester");
    const autoEntries = svc.getTicket(epic.id).audit.filter(
      (e: any) => e.action === "epic_auto_completed",
    ).length;
    expect(autoEntries).toBe(1);
  });
});
