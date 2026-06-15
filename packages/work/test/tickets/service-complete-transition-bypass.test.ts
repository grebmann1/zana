// completeTicket — forced-terminal invariant.
//
// Unlike updateStatus (service.ts), which gates every transition through
// STATUS_TRANSITIONS, completeTicket is a *forced* terminal: it sets status to
// "done" from ANY current status without consulting the state machine. e.g.
// backlog → done is rejected by updateStatus (backlog only allows
// in-progress/cancelled) but accepted by completeTicket. This file pins that
// difference, plus the audit side-effect a future refactor must not drop:
// completeTicket records BOTH a "status_changed" and a "completed" entry.
//
// Behaviour is asserted through the returned ticket (as the sibling
// service-*.test.ts files do), not the event bus: the bus is reached via
// require("@zana-ai/core") inside service.ts, which vi.mock does not intercept.
//
// db I/O is mocked — no real FS.

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
  config: { ZANA_DIR: "/tmp/zana-complete-bypass" },
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
    closedAt: null, resultSummary: null, ...overrides,
  };
  fakeDb._tickets.set(id, t);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("completeTicket — forced terminal that bypasses the status state machine", () => {
  it("completes a backlog ticket directly, even though updateStatus would reject backlog → done", () => {
    // Sanity: prove the transition is genuinely illegal via the gated path.
    const gatedId = seed({ status: "backlog" });
    expect(svc.updateStatus(gatedId, "done", "actor").error)
      .toMatch(/cannot transition from backlog to done/);

    // completeTicket ignores the state machine and forces the terminal status.
    const id = seed({ status: "backlog" });
    const result = svc.completeTicket(id, "shipped early", "agent-1") as any;
    expect(result.ok).toBe(true);
    expect(result.ticket.status).toBe("done");
    expect(result.ticket.resultSummary).toBe("shipped early");
    expect(result.ticket.closedAt).toBeTruthy();
  });

  it("records both a status_changed and a completed audit entry", () => {
    const id = seed({ status: "review" });
    const result = svc.completeTicket(id, "ok", "reviewer") as any;
    const actions = result.ticket.audit.map((a: any) => a.action);
    expect(actions).toContain("status_changed");
    expect(actions).toContain("completed");
    const statusEntry = result.ticket.audit.find((a: any) => a.action === "status_changed");
    expect(statusEntry.details).toEqual({ from: "review", to: "done" });
  });
});
