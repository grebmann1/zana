// Tests service.escalateForDesign (#6 building block): parks a ticket for a
// human design decision.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => (tickets.has(id) ? structuredClone(tickets.get(id)) : null)),
    listTickets: vi.fn(() => [...tickets.values()]), deleteTicket: vi.fn(),
    saveSprint: vi.fn(), getSprint: vi.fn(), listSprints: vi.fn(() => []), deleteSprint: vi.fn(),
    _tickets: tickets,
  };
  const fakeBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { fakeBus, fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);
vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-escalate-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = `t-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const ticket = {
    id, title: "x", description: "", status: "backlog", priority: "high",
    assigneeId: null, assigneeName: null, assigneeProfileId: null,
    reviewPhase: null, reworkCount: 0, sprintId: null, labels: [],
    blockedBy: [], comments: [], audit: [], createdBy: "test",
    createdAt: now, updatedAt: now, closedAt: null, resultSummary: null,
    ...overrides,
  };
  fakeDb._tickets.set(id, ticket);
  return ticket;
}

beforeEach(() => { fakeDb._tickets.clear(); fakeBus.emit.mockClear(); });

describe("service.escalateForDesign", () => {
  it("parks the ticket with awaiting-decision and binds architect", () => {
    const t = seed({ labels: ["architecture"] });
    const res: any = svc.escalateForDesign(t.id, "escalation label", "auto-router");
    expect(res.ok).toBe(true);
    expect(res.escalated).toBe(true);
    const saved = fakeDb._tickets.get(t.id);
    expect(saved.labels).toContain("awaiting-decision");
    expect(saved.assigneeProfileId).toBe("architect");
    expect(saved.audit.some((a: any) => a.action === "escalated")).toBe(true);
  });

  it("does not override an already-bound profile", () => {
    const t = seed({ labels: ["needs-decision"], assigneeProfileId: "performance-engineer" });
    svc.escalateForDesign(t.id, "x", "auto-router");
    expect(fakeDb._tickets.get(t.id).assigneeProfileId).toBe("performance-engineer");
  });

  it("is idempotent — re-escalating a parked ticket is a no-op", () => {
    const t = seed({ labels: ["architecture"] });
    svc.escalateForDesign(t.id, "x", "auto-router");
    const res2: any = svc.escalateForDesign(t.id, "x", "auto-router");
    expect(res2.escalated).toBe(false);
    expect(res2.reason).toBe("already_parked");
    const labels = fakeDb._tickets.get(t.id).labels.filter((l: string) => l === "awaiting-decision");
    expect(labels).toHaveLength(1);
  });

  it("errors for a missing ticket", () => {
    expect(svc.escalateForDesign("nope", "x", "auto-router").error).toBeTruthy();
  });
});
