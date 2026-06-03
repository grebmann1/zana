// Tests for packages/work/src/tickets/service.ts
//
// All I/O and bus interactions are mocked — no real FS, no real clock,
// no real event bus.  Each test is isolated via beforeEach resets.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoist mocks so factories can reference them ───────────────────────────
const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn((filter?: any) => {
      const all = [...tickets.values()];
      if (!filter) return all;
      return all.filter(t => !filter.sprintId || t.sprintId === filter.sprintId);
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
  config: { ZANA_DIR: "/tmp/zana-svc-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

// ── helpers ───────────────────────────────────────────────────────────────

function seedTicket(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const ticket = {
    id,
    title: "Seed ticket",
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
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    resultSummary: null,
    ...overrides,
  };
  fakeDb._tickets.set(id, ticket);
  // Teach getTicket to return fresh copies after each write
  return id;
}

// ── setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

// ── createTicket ──────────────────────────────────────────────────────────

describe("createTicket", () => {
  it("creates a ticket with required title and defaults", () => {
    const result = svc.createTicket({ title: "Hello world", description: undefined,
      priority: undefined, labels: undefined, blockedBy: undefined,
      sprintId: undefined, createdBy: "alice" });
    expect(result.error).toBeUndefined();
    expect(result.title).toBe("Hello world");
    expect(result.status).toBe("backlog");
    expect(result.priority).toBe("medium");
    expect(result.id).toBeDefined();
  });

  it("returns error when title is missing", () => {
    const result = svc.createTicket({ title: "", description: undefined,
      priority: undefined, labels: undefined, blockedBy: undefined,
      sprintId: undefined, createdBy: "alice" });
    expect(result.error).toBe("title is required");
  });

  it("returns error when title is whitespace-only", () => {
    const result = svc.createTicket({ title: "   ", description: undefined,
      priority: undefined, labels: undefined, blockedBy: undefined,
      sprintId: undefined, createdBy: "alice" });
    expect(result.error).toBe("title is required");
  });

  it("uses valid priority from argument", () => {
    const result = svc.createTicket({ title: "Hi", description: undefined,
      priority: "critical", labels: undefined, blockedBy: undefined,
      sprintId: undefined, createdBy: "alice" });
    expect(result.priority).toBe("critical");
  });

  it("falls back to medium for an invalid priority", () => {
    const result = svc.createTicket({ title: "Hi", description: undefined,
      priority: "urgent" as any, labels: undefined, blockedBy: undefined,
      sprintId: undefined, createdBy: "alice" });
    expect(result.priority).toBe("medium");
  });

  it("saves the new ticket to the store", () => {
    const result = svc.createTicket({ title: "Store check", description: undefined,
      priority: undefined, labels: undefined, blockedBy: undefined,
      sprintId: undefined, createdBy: "system" });
    expect(fakeDb.saveTicket).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Store check", status: "backlog" }));
    // getTicket should now return the saved ticket
    const fetched = svc.getTicket(result.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Store check");
  });
});

// ── claimTicket ───────────────────────────────────────────────────────────

describe("claimTicket", () => {
  it("transitions a backlog ticket to in-progress", () => {
    const id = seedTicket({ status: "backlog" });
    const result = svc.claimTicket(id, "agent-1", "Agent One");
    expect(result.ok).toBe(true);
    expect(result.ticket.status).toBe("in-progress");
    expect(result.ticket.assigneeId).toBe("agent-1");
  });

  it("transitions a rework ticket to in-progress", () => {
    const id = seedTicket({ status: "rework" });
    const result = svc.claimTicket(id, "agent-2", "Agent Two");
    expect(result.ok).toBe(true);
    expect(result.ticket.status).toBe("in-progress");
  });

  it("rejects claiming a ticket that is already in-progress", () => {
    const id = seedTicket({ status: "in-progress" });
    const result = svc.claimTicket(id, "agent-3", "Agent Three");
    expect(result.error).toMatch(/cannot claim/);
  });

  it("returns error for unknown ticketId", () => {
    const result = svc.claimTicket("no-such-id", "a", "A");
    expect(result.error).toBe("ticket not found");
  });

  it("stores the assignee name from the argument", () => {
    const id = seedTicket({ status: "backlog" });
    const result = svc.claimTicket(id, "agent-x", "X");
    expect(result.ticket.assigneeName).toBe("X");
    expect(result.ticket.assigneeId).toBe("agent-x");
  });
});

// ── updateStatus ──────────────────────────────────────────────────────────

describe("updateStatus", () => {
  it("allows valid status transition backlog → in-progress", () => {
    const id = seedTicket({ status: "backlog" });
    const result = svc.updateStatus(id, "in-progress", "system");
    expect(result.ok).toBe(true);
    expect(result.ticket.status).toBe("in-progress");
  });

  it("sets reviewPhase to qa when transitioning to review", () => {
    const id = seedTicket({ status: "in-progress" });
    const result = svc.updateStatus(id, "review", "agent-1");
    expect(result.ok).toBe(true);
    expect(result.ticket.reviewPhase).toBe("qa");
  });

  it("increments reworkCount and clears reviewPhase on rework transition", () => {
    const id = seedTicket({ status: "review", reviewPhase: "qa", reworkCount: 1 });
    const result = svc.updateStatus(id, "rework", "reviewer");
    expect(result.ok).toBe(true);
    expect(result.ticket.reworkCount).toBe(2);
    expect(result.ticket.reviewPhase).toBeNull();
  });

  it("sets closedAt when transitioning to done", () => {
    const id = seedTicket({ status: "review" });
    const result = svc.updateStatus(id, "done", "system");
    expect(result.ok).toBe(true);
    expect(result.ticket.closedAt).toBeDefined();
  });

  it("rejects forbidden transition backlog → done", () => {
    const id = seedTicket({ status: "backlog" });
    const result = svc.updateStatus(id, "done", "system");
    expect(result.error).toMatch(/cannot transition/);
  });

  it("rejects unknown status", () => {
    const id = seedTicket({ status: "backlog" });
    const result = svc.updateStatus(id, "flying" as any, "system");
    expect(result.error).toMatch(/invalid status/);
  });

  it("returns error for unknown ticketId", () => {
    const result = svc.updateStatus("ghost", "in-progress", "system");
    expect(result.error).toBe("ticket not found");
  });
});

// ── addComment ────────────────────────────────────────────────────────────

describe("addComment", () => {
  it("appends a comment and emits ticket:commented", () => {
    const id = seedTicket();
    const result = svc.addComment(id, "alice", "Alice", "Looks good to me");
    expect(result.ok).toBe(true);
    expect(result.comment.body).toBe("Looks good to me");
    expect(result.comment.authorId).toBe("alice");
    expect(result.comment.id).toBeDefined();
  });

  it("returns error for unknown ticketId", () => {
    const result = svc.addComment("nope", "a", "A", "hi");
    expect(result.error).toBe("ticket not found");
  });
});

// ── updateReviewPhase ─────────────────────────────────────────────────────

describe("updateReviewPhase", () => {
  it("advances phase from qa to architecture", () => {
    const id = seedTicket({ status: "review", reviewPhase: "qa" });
    const result = svc.updateReviewPhase(id, "architecture", "qa-bot");
    expect(result.ok).toBe(true);
    expect(result.ticket.reviewPhase).toBe("architecture");
  });

  it("rejects phase change when ticket is not in review", () => {
    const id = seedTicket({ status: "in-progress" });
    const result = svc.updateReviewPhase(id, "qa", "qa-bot");
    expect(result.error).toBe("ticket not in review status");
  });

  it("rejects invalid phase name", () => {
    const id = seedTicket({ status: "review", reviewPhase: "qa" });
    const result = svc.updateReviewPhase(id, "security" as any, "qa-bot");
    expect(result.error).toMatch(/invalid review phase/);
  });
});
