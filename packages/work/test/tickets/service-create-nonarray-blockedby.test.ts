// createTicket — non-array `blockedBy` input-boundary behavior.
//
// packages/work/src/tickets/service.ts createTicket() treats `blockedBy`
// inconsistently across two lines:
//
//   line 99:  const deps = Array.isArray(blockedBy) ? blockedBy : [];
//             ...used for the cycle check only — a non-array is coerced to [].
//   line 118: blockedBy: blockedBy || []
//             ...the value actually STORED on the ticket — a non-array truthy
//             value (e.g. a string) survives unnormalized.
//
// So passing a non-array truthy `blockedBy`:
//   - does NOT trigger the cycle guard (deps is [], length 0), and
//   - is persisted raw on the ticket rather than normalized to an array.
//
// Every downstream consumer (getOpenBlockers, wouldCreateCycle) re-guards with
// Array.isArray, so this is benign at read time — but the stored shape is not
// normalized at the boundary. This file pins that current behavior so a future
// refactor that adds normalization (or, conversely, removes the downstream
// guards) is a deliberate, test-visible change. All existing createTicket tests
// pass either a real array or undefined, so this edge is otherwise unexercised.
//
// All I/O is mocked — no real FS, no real bus, no real clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => (tickets.has(id) ? structuredClone(tickets.get(id)) : null)),
    listTickets: vi.fn(() => [...tickets.values()]),
    deleteTicket: vi.fn((id: string) => { tickets.delete(id); }),
    saveSprint: vi.fn((s: any) => { sprints.set(s.id, structuredClone(s)); }),
    getSprint: vi.fn((id: string) => (sprints.has(id) ? structuredClone(sprints.get(id)) : null)),
    listSprints: vi.fn(() => []),
    deleteSprint: vi.fn(),
    _tickets: tickets,
    _sprints: sprints,
  };

  const fakeBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { fakeBus, fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);
vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-create-nonarray-blockedby" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
  fakeDb.listSprints.mockReturnValue([]);
});

describe("createTicket — non-array blockedBy is not normalized to an array", () => {
  it("stores a non-array truthy blockedBy verbatim (string passes through)", () => {
    const ticket = svc.createTicket({
      title: "string blockedBy",
      description: undefined,
      priority: undefined,
      labels: undefined,
      blockedBy: "T-other" as any,
      sprintId: undefined,
      createdBy: "tester",
    });

    // No cycle rejection — the cycle check coerces a non-array to [].
    expect(ticket.error).toBeUndefined();
    // The stored value is the raw string, NOT wrapped/normalized to an array.
    expect(ticket.blockedBy).toBe("T-other");
    const saved = fakeDb.getTicket(ticket.id);
    expect(saved.blockedBy).toBe("T-other");
  });

  it("does not run the cycle guard for a non-array blockedBy (no dep lookups)", () => {
    // deps is [] for a non-array, so wouldCreateCycle never walks the graph and
    // never calls getTicket during creation. The only getTicket call (if any)
    // would come from a sprint backfill, which is disabled here (no active sprint).
    svc.createTicket({
      title: "no cycle walk",
      description: undefined,
      priority: undefined,
      labels: undefined,
      blockedBy: "T-self" as any,
      sprintId: undefined,
      createdBy: "tester",
    });

    expect(fakeDb.getTicket).not.toHaveBeenCalled();
  });

  it("falls back to [] for a falsy non-array blockedBy (empty string)", () => {
    // `blockedBy || []` turns an empty string into [] — the falsy branch.
    const ticket = svc.createTicket({
      title: "empty string blockedBy",
      description: undefined,
      priority: undefined,
      labels: undefined,
      blockedBy: "" as any,
      sprintId: undefined,
      createdBy: "tester",
    });

    expect(ticket.error).toBeUndefined();
    expect(ticket.blockedBy).toEqual([]);
  });
});
