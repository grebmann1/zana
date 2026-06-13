// Focused tests for the `addComment` authorName-fallback path in service.ts.
//
// Line 167 of service.ts:
//   authorName: authorName || authorId,
//
// The existing suite only calls addComment with a truthy authorName.
// This file verifies that:
//   1. null authorName falls back to authorId
//   2. undefined authorName falls back to authorId
//   3. empty-string authorName falls back to authorId  (falsy → same branch)
//   4. a truthy authorName is kept as-is (guard against regression)

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoist mocks ────────────────────────────────────────────────────────────
const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn(() => [...tickets.values()]),
    deleteTicket: vi.fn((id: string) => { tickets.delete(id); }),
    saveSprint: vi.fn((s: any) => { sprints.set(s.id, structuredClone(s)); }),
    getSprint: vi.fn((id: string) => sprints.has(id) ? structuredClone(sprints.get(id)) : null),
    listSprints: vi.fn(() => [...sprints.values()]),
    deleteSprint: vi.fn((id: string) => { sprints.delete(id); }),
    _tickets: tickets,
  };

  const fakeBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { fakeBus, fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);

vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-add-comment-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

// ── helpers ────────────────────────────────────────────────────────────────

function seedTicket() {
  const id = `T-fallback-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  fakeDb._tickets.set(id, {
    id,
    title: "Test ticket",
    description: "",
    status: "in-progress",
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
  });
  return id;
}

beforeEach(() => {
  fakeDb._tickets.clear();
  vi.clearAllMocks();
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("addComment — authorName fallback to authorId", () => {
  it("uses authorId as authorName when authorName is null", () => {
    const id = seedTicket();
    const result = svc.addComment(id, "agent-99", null as any, "LGTM");
    expect(result.ok).toBe(true);
    expect(result.comment.authorName).toBe("agent-99");
  });

  it("uses authorId as authorName when authorName is undefined", () => {
    const id = seedTicket();
    const result = svc.addComment(id, "agent-42", undefined as any, "Needs rework");
    expect(result.ok).toBe(true);
    expect(result.comment.authorName).toBe("agent-42");
  });

  it("uses authorId as authorName when authorName is an empty string", () => {
    const id = seedTicket();
    const result = svc.addComment(id, "agent-7", "", "Done");
    expect(result.ok).toBe(true);
    expect(result.comment.authorName).toBe("agent-7");
  });

  it("keeps the provided authorName when it is a non-empty string", () => {
    const id = seedTicket();
    const result = svc.addComment(id, "agent-1", "Alice the Reviewer", "Ship it");
    expect(result.ok).toBe(true);
    expect(result.comment.authorName).toBe("Alice the Reviewer");
  });
});
