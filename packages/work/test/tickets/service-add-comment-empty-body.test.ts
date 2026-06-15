// Focused edge-case tests for addComment() body handling in service.ts.
//
// The sibling service-add-comment-audit-truncation.test.ts pins long (>100)
// and short non-empty bodies, but leaves two truncation edges unpinned:
//   1. An empty-string body — service.ts line 284 calls `body.slice(0, 100)`,
//      so an empty body must round-trip as "" on both the comment record and
//      the audit entry (no throw, no coercion to null/"undefined").
//   2. The exact 100-char boundary — slice(0, 100) must keep all 100 chars,
//      guarding against an off-by-one that would clip a body sitting right on
//      the limit.
//
// All I/O and bus interactions are mocked — no real FS, no real bus.

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
  config: { ZANA_DIR: "/tmp/zana-add-comment-empty-body-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed() {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  fakeDb._tickets.set(id, {
    id, title: "Seed", description: "", status: "in-progress",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null,
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("addComment — body truncation edges", () => {
  it("round-trips an empty-string body as \"\" on both comment and audit (no throw)", () => {
    const id = seed();

    const result = svc.addComment(id, "agent-1", "Alice", "") as any;
    expect(result.ok).toBe(true);
    expect(result.comment.body).toBe("");

    const saved = fakeDb._tickets.get(id);
    // Comment record stores the empty body verbatim.
    expect(saved.comments).toHaveLength(1);
    expect(saved.comments[0].body).toBe("");
    // Audit entry's truncated body is also "" — not null, undefined, or omitted.
    const commentedEntry = saved.audit.find((a: any) => a.action === "commented");
    expect(commentedEntry).toBeTruthy();
    expect(commentedEntry.details.body).toBe("");
  });

  it("keeps all 100 chars of a body sitting exactly on the truncation boundary", () => {
    const id = seed();
    const exactly100 = "y".repeat(100);

    const result = svc.addComment(id, "agent-1", "Alice", exactly100) as any;
    expect(result.ok).toBe(true);
    expect(result.comment.body).toBe(exactly100);

    const saved = fakeDb._tickets.get(id);
    const commentedEntry = saved.audit.find((a: any) => a.action === "commented");
    expect(commentedEntry.details.body).toHaveLength(100);
    expect(commentedEntry.details.body).toBe(exactly100);
  });
});
