// Regression test for the reconciliation/attestation path (defect #3).
//
// Before the fix, a ticket forced to `rework` by a wrong review could only go
// forward via rework → in-progress → review → … which re-entered the same
// branch-blind reviewer (an infinite false-fail loop), and completeTicket
// accepted only a resultSummary — there was no authorized way to attest
// "verified-done on branch X, tests pass" carrying evidence.
//
// The fix lets completeTicket accept optional evidence
// { branch, commitRange, testResult, attestedBy }, persist it on the `completed`
// audit entry, fold branch/commit into the ticket's workRef, and emit it on
// ticket:completed. It remains a FORCED terminal (bypasses STATUS_TRANSITIONS),
// so it works straight from `rework` without a full rework round-trip.
//
// db I/O is mocked — no real FS. Behaviour asserted via the returned ticket,
// mirroring service-complete-transition-bypass.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
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
  config: { ZANA_DIR: "/tmp/zana-complete-evidence" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const t = {
    id, title: "Seed", description: "", status: "backlog",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null, workRef: null, ...overrides,
  };
  fakeDb._tickets.set(id, t);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("completeTicket — attestation with evidence", () => {
  it("records evidence on the completed audit entry and folds branch/commit into workRef", () => {
    const id = seed({ status: "rework", reworkCount: 3 });
    const evidence = { branch: "0.8.3", commitRange: "main..0.8.3", testResult: "1289 passed", attestedBy: "orchestrator" };

    const result = svc.completeTicket(id, "verified done on 0.8.3", "orchestrator", evidence) as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.status).toBe("done");
    expect(result.ticket.workRef).toEqual({ branch: "0.8.3", commitRange: "main..0.8.3" });

    const completedEntry = result.ticket.audit.find((a: any) => a.action === "completed");
    expect(completedEntry.details.evidence).toEqual(evidence);
  });

  it("reconciles a wrongly-failed ticket straight from rework without a rework round-trip", () => {
    // The whole point of defect #3: rework → done is illegal via updateStatus,
    // but the attestation path forces the terminal from rework directly.
    const id = seed({ status: "rework", reworkCount: 2 });
    expect((svc.updateStatus(id, "done", "actor") as any).error)
      .toMatch(/cannot transition from rework to done/);

    const result = svc.completeTicket(id, "ok", "human", { branch: "feature-x" }) as any;
    expect(result.ok).toBe(true);
    expect(result.ticket.status).toBe("done");
    expect(result.ticket.workRef.branch).toBe("feature-x");
  });

  it("preserves an existing workRef field the implementer recorded", () => {
    const id = seed({ status: "review", workRef: { worktree: "/tmp/wt", branch: "old" } });
    const result = svc.completeTicket(id, "ok", "human", { branch: "new", commitRange: "abc" }) as any;
    // worktree preserved; branch overridden by the attestation; commit added.
    expect(result.ticket.workRef).toEqual({ worktree: "/tmp/wt", branch: "new", commitRange: "abc" });
  });

  it("remains backward-compatible: no evidence arg behaves as before", () => {
    const id = seed({ status: "review" });
    const result = svc.completeTicket(id, "done", "agent-1") as any;
    expect(result.ok).toBe(true);
    expect(result.ticket.status).toBe("done");
    expect(result.ticket.workRef).toBeNull();
    const completedEntry = result.ticket.audit.find((a: any) => a.action === "completed");
    expect(completedEntry.details.evidence).toBeNull();
  });
});
