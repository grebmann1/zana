// Tests for checkpoint store list() filter parameters that are not exercised
// elsewhere: teamId, runId, and status filters (plus result ordering).
// No real network — everything is isolated to a temp directory.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";

describe("checkpoint store: list() filters", () => {
  let tmpRoot: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-list-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("list() with no filter returns all saved checkpoints", () => {
    store.save({ id: "cp-a", teamId: "team-1", status: "running" });
    store.save({ id: "cp-b", teamId: "team-2", status: "done" });
    const all = store.list();
    const ids = all.map((c: any) => c.id);
    expect(ids).toContain("cp-a");
    expect(ids).toContain("cp-b");
  });

  it("list({ teamId }) returns only checkpoints for that team", () => {
    store.save({ id: "t1-a", teamId: "team-alpha", status: "running" });
    store.save({ id: "t1-b", teamId: "team-alpha", status: "done" });
    store.save({ id: "t2-a", teamId: "team-beta", status: "running" });

    const result = store.list({ teamId: "team-alpha" });
    expect(result).toHaveLength(2);
    expect(result.map((c: any) => c.id).sort()).toEqual(["t1-a", "t1-b"].sort());
  });

  it("list({ runId }) returns only the checkpoint with that runId", () => {
    store.save({ id: "r-match", runId: "run-99", teamId: "t1" });
    store.save({ id: "r-other", runId: "run-00", teamId: "t1" });

    const result = store.list({ runId: "run-99" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("r-match");
  });

  it("list({ status }) returns only checkpoints with that status", () => {
    store.save({ id: "s-run", status: "running" });
    store.save({ id: "s-done-1", status: "done" });
    store.save({ id: "s-done-2", status: "done" });

    const running = store.list({ status: "running" });
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe("s-run");

    const done = store.list({ status: "done" });
    expect(done).toHaveLength(2);
  });

  it("list() results are sorted by updatedAt descending (most recent first)", () => {
    // Write checkpoint files directly with explicit, spread timestamps to avoid
    // the same-millisecond problem: three synchronous save() calls may all
    // resolve Date.now() to the same value, making the sort non-deterministic.
    const ckptDir = join(tmpRoot, "checkpoints");
    const base = Date.now();
    writeFileSync(join(ckptDir, "oldest.json"), JSON.stringify({ id: "oldest", updatedAt: base }));
    writeFileSync(join(ckptDir, "middle.json"), JSON.stringify({ id: "middle", updatedAt: base + 1 }));
    writeFileSync(join(ckptDir, "newest.json"), JSON.stringify({ id: "newest", updatedAt: base + 2 }));

    const all = store.list();
    // First item should be the most recently updated
    expect(all[0].id).toBe("newest");
    expect(all[all.length - 1].id).toBe("oldest");
  });

  it("list() returns empty array when no checkpoints match the filter", () => {
    store.save({ id: "cp-1", teamId: "team-x" });
    expect(store.list({ teamId: "nonexistent-team" })).toEqual([]);
    expect(store.list({ status: "nonexistent-status" })).toEqual([]);
  });

  it("list() returns empty array when the checkpoints dir does not exist", () => {
    // Create a fresh dir that was never written to
    const emptyRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-empty-"));
    try {
      store.init(emptyRoot); // no checkpoints subdir yet
      expect(store.list()).toEqual([]);
    } finally {
      store.init(tmpRoot); // restore for afterEach cleanup
      try { rmSync(emptyRoot, { recursive: true, force: true }); } catch {}
    }
  });
});
