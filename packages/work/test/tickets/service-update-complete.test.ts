// Tests for the updateTicket and completeTicket paths in service.ts —
// previously untested.  All I/O and bus interactions are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
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
  config: { ZANA_DIR: "/tmp/zana-test" },
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

// ── updateTicket ──────────────────────────────────────────────────────────────

describe("updateTicket", () => {
  it("returns error for unknown ticketId", () => {
    expect(svc.updateTicket("ghost", { title: "x" }, "actor").error).toBe("ticket not found");
  });

  it("returns error when fields object is empty", () => {
    const id = seed();
    expect(svc.updateTicket(id, {}, "actor").error).toBe("no fields provided");
  });

  it("returns error when only non-updatable fields are supplied", () => {
    const id = seed();
    expect(svc.updateTicket(id, { status: "done" } as any, "actor").error)
      .toMatch(/no valid updatable fields/);
  });

  it("rejects a blank title", () => {
    const id = seed();
    expect(svc.updateTicket(id, { title: "  " }, "actor").error)
      .toMatch(/non-empty string/);
  });

  it("rejects an invalid priority", () => {
    const id = seed();
    expect(svc.updateTicket(id, { priority: "urgent" as any }, "actor").error)
      .toMatch(/invalid priority/);
  });

  it("rejects an invalid type", () => {
    const id = seed();
    expect(svc.updateTicket(id, { type: "task" as any }, "actor").error)
      .toMatch(/invalid type/);
  });

  it("applies valid title + labels updates and persists the ticket", () => {
    const id = seed();
    const result = svc.updateTicket(id, { title: "New title", labels: ["urgent"] }, "alice");
    expect(result.ok).toBe(true);
    expect(result.ticket.title).toBe("New title");
    expect(result.ticket.labels).toEqual(["urgent"]);
    // Verify the updated ticket was persisted via saveTicket
    expect(fakeDb.saveTicket).toHaveBeenCalledWith(
      expect.objectContaining({ id, title: "New title" }),
    );
  });
});

// ── completeTicket ────────────────────────────────────────────────────────────

describe("completeTicket", () => {
  it("returns error for unknown ticketId", () => {
    expect(svc.completeTicket("ghost", "done", "actor").error).toBe("ticket not found");
  });

  it("sets status to done, stores resultSummary, and sets closedAt", () => {
    const id = seed({ status: "review" });
    const result = svc.completeTicket(id, "all good", "qa-bot");
    expect(result.ok).toBe(true);
    expect(result.ticket.status).toBe("done");
    expect(result.ticket.resultSummary).toBe("all good");
    expect(result.ticket.closedAt).toBeTruthy();
  });

  it("persists the completed ticket via saveTicket", () => {
    const id = seed();
    svc.completeTicket(id, "summary", "agent-1");
    expect(fakeDb.saveTicket).toHaveBeenCalledWith(
      expect.objectContaining({ id, status: "done", resultSummary: "summary" }),
    );
  });

  it("accepts null resultSummary", () => {
    const id = seed();
    const result = svc.completeTicket(id, null as any, "system");
    expect(result.ok).toBe(true);
    expect(result.ticket.resultSummary).toBeNull();
  });
});
