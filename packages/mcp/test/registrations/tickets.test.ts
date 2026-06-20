// Unit tests for the zana_ticket_list handler in registrations/tickets.ts.
//
// The handler is the only non-trivial logic in the file: it maps the raw
// ticket objects returned by callCore into a smaller public shape and derives
// `commentCount` from the `comments` array.  All other handlers are thin
// callCore passthroughs, so this is the highest-value target.
//
// Strategy: inject a fake callCore — no daemon, no network, no file I/O.

import { describe, it, expect } from "vitest";
import { tickets } from "../../src/registrations/tickets.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (tickets.handlers as Record<string, Handler>)[name];
}

/** Build a fake callCore that returns `value` regardless of which op is called. */
function fakeCallCore(value: unknown) {
  return (_op: string, _args: unknown) => Promise.resolve(value);
}

/** Minimal raw ticket shape as returned by the core — includes extra fields. */
function rawTicket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t-1",
    title: "Fix the thing",
    status: "backlog",
    priority: "medium",
    assigneeId: null,
    assigneeName: null,
    sprintId: null,
    labels: [],
    type: "feature",
    reviewPhase: null,
    reworkCount: 0,
    blockedBy: [],
    comments: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    internalField: "should not appear",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// zana_ticket_list
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_ticket_list handler", () => {
  const handler = getHandler("zana_ticket_list");

  it("passes status/sprintId/assigneeId/label filters through to callCore", async () => {
    const captured: unknown[] = [];
    const callCore = (op: string, args: unknown) => {
      captured.push({ op, args });
      return Promise.resolve([]);
    };

    await handler(
      { status: "in-progress", sprintId: "s1", assigneeId: "a1", label: "bug" },
      { callCore },
    );

    expect(captured).toHaveLength(1);
    expect((captured[0] as any).op).toBe("ticket_list");
    expect((captured[0] as any).args).toMatchObject({
      status: "in-progress",
      sprintId: "s1",
      assigneeId: "a1",
      label: "bug",
    });
  });

  it("returns non-array callCore responses unchanged (e.g. error objects)", async () => {
    const errorResponse = { error: "not found" };
    const result = await handler({}, { callCore: fakeCallCore(errorResponse) });
    expect(result).toBe(errorResponse);
  });

  it("maps an array of tickets to the public summary shape", async () => {
    const raw = rawTicket({ id: "t-42", title: "My ticket", status: "review", reworkCount: 1 });
    const [mapped] = (await handler({}, { callCore: fakeCallCore([raw]) })) as any[];

    expect(mapped).toMatchObject({
      id: "t-42",
      title: "My ticket",
      status: "review",
      priority: "medium",
      reworkCount: 1,
    });
  });

  it("strips private fields not present in the public summary shape", async () => {
    const raw = rawTicket();
    const [mapped] = (await handler({}, { callCore: fakeCallCore([raw]) })) as any[];
    expect(mapped).not.toHaveProperty("internalField");
  });

  it("derives commentCount from comments.length when comments is an array", async () => {
    const raw = rawTicket({ comments: ["c1", "c2", "c3"] });
    const [mapped] = (await handler({}, { callCore: fakeCallCore([raw]) })) as any[];
    expect(mapped.commentCount).toBe(3);
  });

  it("sets commentCount to 0 when comments is absent", async () => {
    const { comments: _omit, ...rawNoComments } = rawTicket() as any;
    const [mapped] = (await handler({}, { callCore: fakeCallCore([rawNoComments]) })) as any[];
    expect(mapped.commentCount).toBe(0);
  });

  it("sets commentCount to 0 when comments is null (non-array)", async () => {
    const raw = rawTicket({ comments: null });
    const [mapped] = (await handler({}, { callCore: fakeCallCore([raw]) })) as any[];
    expect(mapped.commentCount).toBe(0);
  });

  it("handles empty ticket list returning an empty array", async () => {
    const result = await handler({}, { callCore: fakeCallCore([]) });
    expect(result).toEqual([]);
  });

  it("maps multiple tickets independently", async () => {
    const raws = [
      rawTicket({ id: "t-1", comments: ["x"] }),
      rawTicket({ id: "t-2", comments: [] }),
    ];
    const mapped = (await handler({}, { callCore: fakeCallCore(raws) })) as any[];
    expect(mapped).toHaveLength(2);
    expect(mapped[0].commentCount).toBe(1);
    expect(mapped[1].commentCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_ticket_complete
//
// Not a thin passthrough: it slims the core's full result down to
// { ok, ticketId, status, closedAt } and applies fallbacks when the core omits
// fields. Those defaults are the behavior worth pinning.
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_ticket_complete handler", () => {
  const handler = getHandler("zana_ticket_complete");

  it("forwards ticketId/resultSummary/evidence to the ticket_complete op", async () => {
    const captured: unknown[] = [];
    const callCore = (op: string, args: unknown) => {
      captured.push({ op, args });
      return Promise.resolve({ ok: true, ticket: { id: "t-1" } });
    };
    const evidence = { branch: "main", testResult: "10 passed" };

    await handler({ ticketId: "t-1", resultSummary: "did it", evidence }, { callCore });

    expect(captured).toHaveLength(1);
    expect((captured[0] as any).op).toBe("ticket_complete");
    expect((captured[0] as any).args).toMatchObject({
      ticketId: "t-1",
      resultSummary: "did it",
      evidence,
    });
  });

  it("slims the core result to ok/ticketId/status/closedAt only", async () => {
    const fullTicket = {
      id: "t-9",
      status: "done",
      closedAt: "2026-01-02T00:00:00Z",
      description: "huge",
      comments: ["a", "b"],
      audit: [{ x: 1 }],
    };
    const result = (await handler(
      { ticketId: "t-9", resultSummary: "done" },
      { callCore: fakeCallCore({ ok: true, ticket: fullTicket }) },
    )) as Record<string, unknown>;

    expect(result).toEqual({
      ok: true,
      ticketId: "t-9",
      status: "done",
      closedAt: "2026-01-02T00:00:00Z",
    });
  });

  it("defaults ok=true, status='done', closedAt=null and echoes args.ticketId when the core omits the ticket", async () => {
    const result = (await handler(
      { ticketId: "t-7", resultSummary: "done" },
      { callCore: fakeCallCore({}) },
    )) as Record<string, unknown>;

    expect(result).toEqual({
      ok: true,
      ticketId: "t-7",
      status: "done",
      closedAt: null,
    });
  });

  it("preserves an explicit ok:false from the core", async () => {
    const result = (await handler(
      { ticketId: "t-3", resultSummary: "nope" },
      { callCore: fakeCallCore({ ok: false }) },
    )) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.ticketId).toBe("t-3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_ticket_children
//
// Not a thin passthrough: it slims each raw child ticket down to a fixed
// public shape ({id,title,status,priority,assigneeId,parentId}) and drops
// every other field, but only when the core returns an array. A non-array
// result (e.g. an error envelope) is passed through untouched. Both branches
// are the behavior worth pinning.
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_ticket_children handler", () => {
  const handler = getHandler("zana_ticket_children");

  it("forwards ticketId to the ticket_children op", async () => {
    const captured: unknown[] = [];
    const callCore = (op: string, args: unknown) => {
      captured.push({ op, args });
      return Promise.resolve([]);
    };

    await handler({ ticketId: "epic-1" }, { callCore });

    expect(captured).toHaveLength(1);
    expect((captured[0] as any).op).toBe("ticket_children");
    expect((captured[0] as any).args).toEqual({ ticketId: "epic-1" });
  });

  it("slims each child to the public shape and drops extra fields", async () => {
    const children = [
      rawTicket({ id: "c-1", parentId: "epic-1", internalField: "secret" }),
      rawTicket({ id: "c-2", parentId: "epic-1", title: "Second", status: "done", priority: "high" }),
    ];
    const result = (await handler(
      { ticketId: "epic-1" },
      { callCore: fakeCallCore(children) },
    )) as Array<Record<string, unknown>>;

    expect(result).toEqual([
      { id: "c-1", title: "Fix the thing", status: "backlog", priority: "medium", assigneeId: null, parentId: "epic-1" },
      { id: "c-2", title: "Second", status: "done", priority: "high", assigneeId: null, parentId: "epic-1" },
    ]);
    // Extra raw fields must not leak through.
    expect(result[0]).not.toHaveProperty("internalField");
    expect(result[0]).not.toHaveProperty("comments");
  });

  it("passes a non-array core result through untouched", async () => {
    const errorEnvelope = { ok: false, error: "not an epic" };
    const result = await handler(
      { ticketId: "t-1" },
      { callCore: fakeCallCore(errorEnvelope) },
    );

    expect(result).toEqual(errorEnvelope);
  });
});
