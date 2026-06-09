import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("createSprint + getSprintBoard", () => {
  let tmpDir: string;
  let svc: any;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sprint-board-"));
    // Pre-create .zana/ so resolveProjectDir anchors here and doesn't walk
    // up to /tmp/.zana/ (the real workspace), which is sandbox-blocked.
    mkdirSync(join(tmpDir, ".zana"), { recursive: true });
    const ws = await import("@zana-ai/core/src/project/workspace-context.ts");
    ws.init(tmpDir);
    // Also init the dist instance — db.ts reaches workspaceContext via
    // require("@zana-ai/core") which resolves to dist; otherwise the
    // tenant-isolation gate refuses the open.
    const core = await import("@zana-ai/core");
    try { (core as any).project.workspaceContext.init(tmpDir); } catch {}
    svc = await import("@zana-ai/work/src/tickets/service.ts");
  });

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    try {
      const ws = await import("@zana-ai/core/src/project/workspace-context.ts");
      (ws as any)._resetForTesting?.();
    } catch {}
    try {
      const core = await import("@zana-ai/core");
      (core as any).project.workspaceContext._resetForTesting?.();
    } catch {}
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
