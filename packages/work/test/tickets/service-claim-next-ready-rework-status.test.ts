// claimNextReady end-to-end over a `rework`-status ticket.
//
// listReadyTickets includes BOTH backlog and rework candidates, and
// claimTicket's status gate permits `backlog` || `rework`. The existing
// claimNextReady suite (service-dependency-ordering, *-all-lost, *-skip-lost,
// *-priority-head, *-sprint-filter) seeds ONLY backlog tickets, so the
// rework → dispatch wiring is never driven through the claimNextReady entry
// point. The "includes rework tickets" assertion in service-dependency-ordering
// only checks listReadyTickets()'s output, never an actual claim.
//
// This pins the full dispatch of a rework ticket: claimNextReady must select
// it, transition rework → in-progress, clear reviewPhase, and record the audit
// transition with `from: "rework"`. A regression that dropped rework from the
// ready set (or rejected it in the status gate) would slip past every current
// test. Deterministic — all I/O mocked, no real db/bus/clock-dependent asserts.

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
  config: { ZANA_DIR: "/tmp/zana-claim-rework-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedTicket(overrides: Record<string, any> = {}) {
  const id = overrides.id;
  const createdAt = overrides.createdAt || "2026-01-01T00:00:00.000Z";
  const ticket = {
    id,
    title: `Ticket ${id}`,
    description: "",
    status: "backlog",
    priority: "medium",
    assigneeId: null,
    assigneeName: null,
    assigneeProfileId: null,
    reviewPhase: null,
    reworkCount: 0,
    sprintId: null,
    labels: [],
    blockedBy: [],
    comments: [],
    audit: [],
    createdBy: "test",
    createdAt,
    updatedAt: createdAt,
    closedAt: null,
    resultSummary: null,
    ...overrides,
  };
  fakeDb._tickets.set(id, ticket);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

describe("claimNextReady — claims a rework-status ticket end-to-end", () => {
  it("dispatches a rework ticket: transitions rework → in-progress and clears reviewPhase", () => {
    // A ticket bounced back from review carries status=rework with a lingering
    // reviewPhase. It is the only dispatchable ticket, so claimNextReady must
    // select and claim it via the rework candidate path.
    seedTicket({ id: "REWORKED", status: "rework", reviewPhase: "qa", reworkCount: 1 });

    const res: any = svc.claimNextReady("agent-1", "Agent One", "profile-x");

    expect(res.ok).toBe(true);
    expect(res.ticket.id).toBe("REWORKED");
    expect(res.ticket.status).toBe("in-progress");
    // reviewPhase is reset on claim so the re-run starts a fresh review cycle.
    expect(res.ticket.reviewPhase).toBeNull();
    expect(res.ticket.assigneeId).toBe("agent-1");
    expect(res.ticket.assigneeProfileId).toBe("profile-x");

    // The status transition was audited as coming FROM rework, not backlog.
    const statusChange = res.ticket.audit.find((a: any) => a.action === "status_changed");
    expect(statusChange).toBeDefined();
    expect(statusChange.details.from).toBe("rework");
    expect(statusChange.details.to).toBe("in-progress");

    // The persisted ticket reflects the claim.
    expect(svc.getTicket("REWORKED").status).toBe("in-progress");
  });
});
