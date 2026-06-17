// Tests service.assignProfile (#2 auto-assign building block). The router→ticket
// bridge lives in core.ts (work must not depend on intelligence), so here we
// test the service primitive it calls:
//   - confident profile  → assigneeProfileId bound, audit entry, ticket:updated.
//   - no profile (null)   → ticket tagged `needs-triage`, not assigned.
//   - already assigned    → never overridden (explicit/human intent wins).
//   - needs-triage label is idempotent.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => (tickets.has(id) ? structuredClone(tickets.get(id)) : null)),
    listTickets: vi.fn(() => [...tickets.values()]),
    deleteTicket: vi.fn(),
    saveSprint: vi.fn(),
    getSprint: vi.fn(),
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
  config: { ZANA_DIR: "/tmp/zana-assign-profile-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = `t-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const ticket = {
    id, title: "x", description: "", status: "backlog", priority: "medium",
    assigneeId: null, assigneeName: null, assigneeProfileId: null,
    reviewPhase: null, reworkCount: 0, sprintId: null, labels: [],
    blockedBy: [], comments: [], audit: [], createdBy: "test",
    createdAt: now, updatedAt: now, closedAt: null, resultSummary: null,
    ...overrides,
  };
  fakeDb._tickets.set(id, ticket);
  return ticket;
}

beforeEach(() => {
  fakeDb._tickets.clear();
  fakeBus.emit.mockClear();
});

describe("service.assignProfile", () => {
  it("binds a confident profile and records an audit entry", () => {
    const t = seed();
    const res: any = svc.assignProfile(t.id, "backend-dev", "auto-router");
    expect(res.ok).toBe(true);
    expect(res.assigned).toBe(true);
    expect(fakeDb._tickets.get(t.id).assigneeProfileId).toBe("backend-dev");
    expect(fakeDb._tickets.get(t.id).audit.some((a: any) => a.action === "profile_assigned")).toBe(true);
  });

  it("tags needs-triage when no confident profile is given", () => {
    const t = seed();
    const res: any = svc.assignProfile(t.id, null, "auto-router");
    expect(res.ok).toBe(true);
    expect(res.assigned).toBe(false);
    expect(res.reason).toBe("no_confident_profile");
    expect(fakeDb._tickets.get(t.id).assigneeProfileId).toBe(null);
    expect(fakeDb._tickets.get(t.id).labels).toContain("needs-triage");
  });

  it("never overrides an already-bound profile", () => {
    const t = seed({ assigneeProfileId: "architect" });
    const res: any = svc.assignProfile(t.id, "backend-dev", "auto-router");
    expect(res.ok).toBe(true);
    expect(res.assigned).toBe(false);
    expect(res.reason).toBe("already_assigned");
    expect(fakeDb._tickets.get(t.id).assigneeProfileId).toBe("architect");
  });

  it("needs-triage label is idempotent across repeated calls", () => {
    const t = seed();
    svc.assignProfile(t.id, null, "auto-router");
    svc.assignProfile(t.id, null, "auto-router");
    const labels = fakeDb._tickets.get(t.id).labels.filter((l: string) => l === "needs-triage");
    expect(labels).toHaveLength(1);
  });

  it("returns an error for a missing ticket", () => {
    const res: any = svc.assignProfile("nope", "backend-dev", "auto-router");
    expect(res.error).toBeTruthy();
  });
});
