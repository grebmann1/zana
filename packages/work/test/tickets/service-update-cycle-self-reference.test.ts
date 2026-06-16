// Focused test for the direct-self-reference branch of service.wouldCreateCycle,
// reached via updateTicket.
//
// service.ts wouldCreateCycle returns true on the very first pop when a
// proposed blocker IS the ticket itself:
//   const cur = stack.pop();
//   if (cur === ticketId) return true;   // <-- this branch
//
// Existing update-time cycle tests exercise *transitive* loops
// (service-update-cycle-diamond-dag: A → D → … → A) and *missing* deps
// (service-update-cycle-dangling-blocker). service-create-cycle-rejection
// hits `cur === ticketId`, but only through createTicket — a different entry
// with a different guard site. None drive the realistic user path: editing an
// EXISTING ticket so its blockedBy points at its own id. That self-loop would
// deadlock the ticket forever (it can never reach a terminal status to unblock
// itself), so updateTicket must reject it AND must not persist the edit.
//
// All I/O is mocked — no real FS, no real bus, deterministic.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => (tickets.has(id) ? structuredClone(tickets.get(id)) : null)),
    listTickets: vi.fn(() => [...tickets.values()]),
    deleteTicket: vi.fn(),
    saveSprint: vi.fn(),
    getSprint: vi.fn(() => null),
    listSprints: vi.fn(() => []),
    deleteSprint: vi.fn(),
    _tickets: tickets,
  };
  const fakeBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { fakeBus, fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);

vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-self-reference-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedTicket(overrides: Record<string, any>) {
  const now = new Date().toISOString();
  const t = {
    title: "seed", description: "", status: "backlog", priority: "medium",
    assigneeId: null, assigneeName: null, assigneeProfileId: null,
    reviewPhase: null, reworkCount: 0, sprintId: null, labels: [],
    blockedBy: [], comments: [], audit: [], createdBy: "test",
    createdAt: now, updatedAt: now, closedAt: null, resultSummary: null,
    ...overrides,
  };
  fakeDb._tickets.set(t.id, t);
  return t.id;
}

describe("updateTicket — direct self-referential blockedBy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb._tickets.clear();
  });

  it("rejects pointing a ticket's blockedBy at its own id and does not persist", () => {
    // S already exists with no blockers. Editing it to block on itself hits
    // `cur === ticketId` on the first pop of the walk → cycle error.
    const s = seedTicket({ id: "S", blockedBy: [] });

    const res: any = svc.updateTicket(s, { blockedBy: ["S"] }, "tester");

    expect(res.error).toMatch(/dependency cycle/);
    // The rejected edit must not be persisted — blockedBy stays empty.
    expect(svc.getTicket("S").blockedBy).toEqual([]);
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
  });

  it("still detects the self-loop when own id is mixed with an unrelated blocker", () => {
    // S → [OTHER, S]. OTHER is unrelated (no path back), but the own-id entry
    // alone closes the loop; the guard must fire regardless of ordering.
    const s = seedTicket({ id: "S", blockedBy: [] });
    seedTicket({ id: "OTHER", blockedBy: [] });

    const res: any = svc.updateTicket(s, { blockedBy: ["OTHER", "S"] }, "tester");

    expect(res.error).toMatch(/dependency cycle/);
    expect(svc.getTicket("S").blockedBy).toEqual([]);
  });
});
