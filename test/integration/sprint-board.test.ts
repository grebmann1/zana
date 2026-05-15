import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("createSprint + getSprintBoard", () => {
  let tmpDir: string;
  let svc: any;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sprint-board-"));
    const ws = await import("@zana/core/src/project/workspace-context.ts");
    ws.init(tmpDir);
    svc = await import("@zana/work/src/tickets/service.ts");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("backfills sprintId on each ticket when sprint is created with ticketIds", () => {
    const t1 = svc.createTicket({ title: "T1", description: "d", priority: "low" });
    const t2 = svc.createTicket({ title: "T2", description: "d", priority: "low" });
    const sprint = svc.createSprint({ name: "S1", ticketIds: [t1.id, t2.id] });
    expect(sprint.ticketIds).toEqual([t1.id, t2.id]);
    const t1After = svc.getTicket(t1.id);
    const t2After = svc.getTicket(t2.id);
    expect(t1After.sprintId).toBe(sprint.id);
    expect(t2After.sprintId).toBe(sprint.id);
  });

  it("getSprintBoard returns tickets grouped by status", () => {
    const t1 = svc.createTicket({ title: "T1", description: "d", priority: "low" });
    const t2 = svc.createTicket({ title: "T2", description: "d", priority: "low" });
    const sprint = svc.createSprint({ name: "S1", ticketIds: [t1.id, t2.id] });
    const board = svc.getSprintBoard(sprint.id);
    expect(board.backlog.length).toBe(2);
    svc.claimTicket(t1.id, "agent-1", "Agent 1");
    const board2 = svc.getSprintBoard(sprint.id);
    expect(board2.backlog.length).toBe(1);
    expect(board2["in-progress"].length).toBe(1);
  });
});
