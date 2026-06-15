// addComment — comment record + ticket-mutation contract.
//
// The sibling service-add-comment-*.test.ts files pin the audit-body truncation
// and the authorName→authorId fallback, asserting only `result.comment.body` /
// `result.comment.authorName`. None of them verify the *core* effect of
// addComment: that the new comment is appended to ticket.comments AND persisted,
// that the returned comment carries a generated id + ISO createdAt, and that the
// ticket's updatedAt is bumped to the comment's timestamp. This file closes that
// gap — all observed via the returned value and the (mocked) store, matching the
// repo convention of not asserting the runtime-require event bus.
//
// db I/O is mocked — no real FS, deterministic.

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
  config: { ZANA_DIR: "/tmp/zana-add-comment-mutation" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const earlier = "2020-01-01T00:00:00.000Z";
  const t = {
    id, title: "Seed", description: "", status: "review",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: earlier, updatedAt: earlier,
    closedAt: null, resultSummary: null, ...overrides,
  };
  fakeDb._tickets.set(id, t);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("addComment — comment record + ticket mutation", () => {
  it("returns a comment with a generated id and ISO createdAt", () => {
    const id = seed();
    const result = svc.addComment(id, "agent-1", "Alice", "LGTM") as any;

    expect(result.ok).toBe(true);
    expect(typeof result.comment.id).toBe("string");
    expect(result.comment.id.length).toBeGreaterThan(0);
    expect(result.comment.createdAt).toMatch(ISO_RE);
    expect(result.comment.authorId).toBe("agent-1");
    expect(result.comment.body).toBe("LGTM");
  });

  it("appends the comment to ticket.comments and persists it via saveTicket", () => {
    const id = seed();
    const result = svc.addComment(id, "agent-1", "Alice", "first comment") as any;

    const saved = fakeDb._tickets.get(id);
    expect(saved.comments).toHaveLength(1);
    expect(saved.comments[0].id).toBe(result.comment.id);
    expect(saved.comments[0].body).toBe("first comment");
    // saveTicket must have received the ticket carrying the new comment.
    const savedArg = fakeDb.saveTicket.mock.calls.at(-1)?.[0];
    expect(savedArg.comments).toContainEqual(
      expect.objectContaining({ id: result.comment.id, body: "first comment" }),
    );
  });

  it("bumps ticket.updatedAt to the comment's createdAt", () => {
    const id = seed();
    const result = svc.addComment(id, "agent-1", "Alice", "ping") as any;

    const saved = fakeDb._tickets.get(id);
    expect(saved.updatedAt).toBe(result.comment.createdAt);
    // The seed's stale updatedAt must have been replaced.
    expect(saved.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("preserves existing comments and appends in order", () => {
    const id = seed();
    svc.addComment(id, "agent-1", "Alice", "one");
    svc.addComment(id, "agent-2", "Bob", "two");

    const saved = fakeDb._tickets.get(id);
    expect(saved.comments.map((c: any) => c.body)).toEqual(["one", "two"]);
  });
});
