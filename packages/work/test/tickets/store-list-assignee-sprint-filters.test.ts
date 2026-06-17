// Tests for the assigneeId and sprintId filter branches of
// packages/work/src/tickets/store.ts listTickets().
//
// store.test.ts exercises the status / label / priority filters but leaves
// two of listTickets' five filter branches unpinned:
//   if (filter.sprintId)   tickets = tickets.filter(t => t.sprintId === ...)
//   if (filter.assigneeId) tickets = tickets.filter(t => t.assigneeId === ...)
// This file pins both, plus their conjunction, so a refactor that drops or
// reorders a branch fails loudly. Uses a real temp workspace (no FS mock),
// matching store.test.ts conventions.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/work/src/tickets/store.ts";

function makeTicket(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `T-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: "Test ticket",
    status: "backlog",
    priority: "medium",
    assigneeId: null,
    sprintId: null,
    labels: [] as string[],
    comments: [],
    audit: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

let TEST_WORKSPACE: string;

beforeEach(() => {
  TEST_WORKSPACE = path.join(
    os.tmpdir(),
    `zana-test-store-filters-${Date.now()}-${process.pid}`
  );
  fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
  workspaceContext.init(TEST_WORKSPACE);
  try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
});

afterEach(() => {
  try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
});

describe("listTickets — assigneeId filter", () => {
  it("returns only tickets assigned to the given agent", () => {
    store.saveTicket(makeTicket({ id: "T-mine", assigneeId: "agent-1" }));
    store.saveTicket(makeTicket({ id: "T-theirs", assigneeId: "agent-2" }));
    store.saveTicket(makeTicket({ id: "T-unassigned", assigneeId: null }));

    const results = store.listTickets({ assigneeId: "agent-1" });
    const ids = results.map((t) => t.id);
    expect(ids).toEqual(["T-mine"]);
    expect(results.every((t) => t.assigneeId === "agent-1")).toBe(true);
  });
});

describe("listTickets — sprintId filter", () => {
  it("returns only tickets belonging to the given sprint", () => {
    store.saveTicket(makeTicket({ id: "T-s1-a", sprintId: "sprint-1" }));
    store.saveTicket(makeTicket({ id: "T-s1-b", sprintId: "sprint-1" }));
    store.saveTicket(makeTicket({ id: "T-s2", sprintId: "sprint-2" }));

    const ids = store.listTickets({ sprintId: "sprint-1" }).map((t) => t.id);
    expect(ids).toContain("T-s1-a");
    expect(ids).toContain("T-s1-b");
    expect(ids).not.toContain("T-s2");
  });
});

describe("listTickets — assigneeId and sprintId combined", () => {
  it("applies both filters conjunctively", () => {
    store.saveTicket(makeTicket({ id: "T-match", assigneeId: "agent-1", sprintId: "sprint-1" }));
    // Same sprint, different assignee — excluded by assigneeId.
    store.saveTicket(makeTicket({ id: "T-wrong-agent", assigneeId: "agent-2", sprintId: "sprint-1" }));
    // Same assignee, different sprint — excluded by sprintId.
    store.saveTicket(makeTicket({ id: "T-wrong-sprint", assigneeId: "agent-1", sprintId: "sprint-2" }));

    const ids = store.listTickets({ assigneeId: "agent-1", sprintId: "sprint-1" }).map((t) => t.id);
    expect(ids).toEqual(["T-match"]);
  });
});
