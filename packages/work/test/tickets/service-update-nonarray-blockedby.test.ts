// updateTicket — non-array `blockedBy` input-boundary behavior.
//
// packages/work/src/tickets/service.ts updateTicket() treats `blockedBy`
// inconsistently across two lines, mirroring the create-side seam pinned by
// service-create-nonarray-blockedby.test.ts:
//
//   line 324: const deps = Array.isArray(fields.blockedBy) ? fields.blockedBy : [];
//             ...used for the cycle check only — a non-array is coerced to [],
//             so the cycle guard never walks the dependency graph.
//   line 334: ticket[key] = fields[key];
//             ...the allow-list loop writes the RAW field value, so a non-array
//             truthy blockedBy (e.g. a string) is persisted unnormalized.
//
// So updating with a non-array truthy `blockedBy`:
//   - does NOT trigger the cycle guard (deps is [], length 0), and
//   - is persisted raw on the ticket rather than normalized to an array, and
//   - is still recorded as a changed field in the audit entry.
//
// Downstream readers (getOpenBlockers, wouldCreateCycle) re-guard with
// Array.isArray, so this is benign at read time — but the stored shape is not
// normalized at the boundary. This pins the current behavior so a future
// refactor that adds normalization (or removes the downstream guards) is a
// deliberate, test-visible change. The sibling update-side tests only pass real
// arrays (or []), so this edge is otherwise unexercised on the update path.
//
// All I/O is mocked — no real FS, no real bus, no real clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => (tickets.has(id) ? structuredClone(tickets.get(id)) : null)),
    listTickets: vi.fn(() => [...tickets.values()]),
    deleteTicket: vi.fn((id: string) => { tickets.delete(id); }),
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
  config: { ZANA_DIR: "/tmp/zana-update-nonarray-blockedby" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  fakeDb._tickets.set(id, {
    id, title: "Seed", description: "", status: "backlog",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null, ...overrides,
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("updateTicket — non-array blockedBy is not normalized to an array", () => {
  it("stores a non-array truthy blockedBy verbatim and skips the cycle guard", () => {
    const id = seed({ blockedBy: [] });
    vi.clearAllMocks(); // forget the seed bookkeeping; count only update-path getTicket calls

    const result = svc.updateTicket(id, { blockedBy: "T-other" as any }, "actor") as any;

    // No cycle rejection — deps is [] for a non-array, so the guard never fires.
    expect(result.ok).toBe(true);
    // The stored value is the raw string, NOT wrapped/normalized to an array.
    expect(result.ticket.blockedBy).toBe("T-other");
    expect(fakeDb._tickets.get(id).blockedBy).toBe("T-other");
    // The cycle guard never walked the graph: the only getTicket call is the
    // initial lookup at the top of updateTicket (wouldCreateCycle would add more).
    expect(fakeDb.getTicket).toHaveBeenCalledTimes(1);
  });

  it("records blockedBy as a changed field in the audit entry for a non-array value", () => {
    const id = seed({ blockedBy: [] });

    const result = svc.updateTicket(id, { blockedBy: "T-dep" as any }, "actor") as any;

    expect(result.ok).toBe(true);
    const updatedEntry = result.ticket.audit.find((a: any) => a.action === "updated");
    expect(updatedEntry).toBeDefined();
    expect(updatedEntry.details.fields).toContain("blockedBy");
  });
});
