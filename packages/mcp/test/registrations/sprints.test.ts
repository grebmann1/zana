// Unit tests for registrations/sprints.ts
//
// The only non-trivial handler is zana_sprint_board: it slims each ticket
// to {id,title,status,priority,assigneeName,labels,closedAt} when verbose
// is absent/false, and passes the raw board through when verbose=true.
// All other handlers are thin callCore passthroughs and are not tested here.
//
// Strategy: inject a fake callCore — no daemon, no network, no file I/O.

import { describe, it, expect } from "vitest";
import { sprints } from "../../src/registrations/sprints.ts";

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (sprints.handlers as Record<string, Handler>)[name];
}

function fakeCallCore(value: unknown) {
  return (_op: string, _args: unknown) => Promise.resolve(value);
}

/** Raw ticket with extra fields that should be stripped in slim mode. */
function rawTicket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "T-1",
    title: "Do the thing",
    status: "backlog",
    priority: "medium",
    assigneeName: "alice",
    labels: ["bug"],
    closedAt: null,
    description: "Long description that should not appear in slim mode",
    comments: [{ text: "hi" }],
    reworkCount: 0,
    ...overrides,
  };
}

const handler = getHandler("zana_sprint_board");

// ─── slim mode (verbose absent / false) ───────────────────────────────────────

describe("zana_sprint_board – slim mode", () => {
  it("returns only the allowed slim fields for each ticket", async () => {
    const board = { backlog: [rawTicket()], "in-progress": [] };
    const ctx = { callCore: fakeCallCore(board) };
    const result: any = await handler({ sprintId: "s-1" }, ctx);

    const ticket = result.backlog[0];
    expect(Object.keys(ticket).sort()).toEqual(
      ["assigneeName", "closedAt", "id", "labels", "priority", "status", "title"]
    );
  });

  it("strips description and comments from slim output", async () => {
    const board = { backlog: [rawTicket()] };
    const ctx = { callCore: fakeCallCore(board) };
    const result: any = await handler({ sprintId: "s-1" }, ctx);

    expect(result.backlog[0]).not.toHaveProperty("description");
    expect(result.backlog[0]).not.toHaveProperty("comments");
  });

  it("preserves all columns in the board output", async () => {
    const board = {
      backlog: [rawTicket({ id: "T-1" })],
      "in-progress": [rawTicket({ id: "T-2", status: "in-progress" })],
      done: [],
    };
    const ctx = { callCore: fakeCallCore(board) };
    const result: any = await handler({ sprintId: "s-1" }, ctx);

    expect(result.backlog).toHaveLength(1);
    expect(result["in-progress"]).toHaveLength(1);
    expect(result.done).toEqual([]);
  });

  it("maps assigneeName null correctly", async () => {
    const board = { backlog: [rawTicket({ assigneeName: null })] };
    const ctx = { callCore: fakeCallCore(board) };
    const result: any = await handler({ sprintId: "s-1" }, ctx);

    expect(result.backlog[0].assigneeName).toBeNull();
  });

  it("defaults labels to [] when ticket has no labels field", async () => {
    const ticket = rawTicket();
    delete (ticket as any).labels;
    const board = { backlog: [ticket] };
    const ctx = { callCore: fakeCallCore(board) };
    const result: any = await handler({ sprintId: "s-1" }, ctx);

    expect(result.backlog[0].labels).toEqual([]);
  });

  it("defaults closedAt to null when ticket has no closedAt field", async () => {
    const ticket = rawTicket();
    delete (ticket as any).closedAt;
    const board = { backlog: [ticket] };
    const ctx = { callCore: fakeCallCore(board) };
    const result: any = await handler({ sprintId: "s-1" }, ctx);

    expect(result.backlog[0].closedAt).toBeNull();
  });

  it("handles an empty board (no columns)", async () => {
    const ctx = { callCore: fakeCallCore({}) };
    const result: any = await handler({ sprintId: "s-1" }, ctx);
    expect(result).toEqual({});
  });
});

// ─── verbose mode ─────────────────────────────────────────────────────────────

describe("zana_sprint_board – verbose mode", () => {
  it("returns the raw board unchanged when verbose=true", async () => {
    const board = { backlog: [rawTicket()] };
    const ctx = { callCore: fakeCallCore(board) };
    const result: any = await handler({ sprintId: "s-1", verbose: true }, ctx);

    expect(result).toBe(board); // exact same reference — no copying
  });

  it("includes description and comments in verbose output", async () => {
    const board = { backlog: [rawTicket()] };
    const ctx = { callCore: fakeCallCore(board) };
    const result: any = await handler({ sprintId: "s-1", verbose: true }, ctx);

    expect(result.backlog[0]).toHaveProperty("description");
    expect(result.backlog[0]).toHaveProperty("comments");
  });
});
