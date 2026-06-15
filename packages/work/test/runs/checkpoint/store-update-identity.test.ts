// Identity-integrity tests for update() in
// packages/work/src/runs/checkpoint/store.ts.
//
// update() builds the merged record as { ...existing, ...updates, id,
// updatedAt: Date.now() } — the explicit `id` AFTER the spread means an `id`
// field smuggled into the updates payload must be IGNORED, and the record's
// lineage (`createdAt`) must survive the read-modify-write. The existing
// store.test.ts pins the updatedAt bump but neither of these invariants; a
// regression that moved `id` before `...updates` would let a caller rewrite a
// checkpoint under a new id (orphaning the old file) without any test failing.
//
// Deterministic: all fs I/O lives in a tmp dir torn down in afterEach; no
// clock or network dependency.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

describe("checkpoint store: update() identity integrity", () => {
  let tmpRoot: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-upd-id-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("update() ignores an id override in the updates payload and keeps the original id", () => {
    store.save({ id: "real-id", teamId: "t", status: "running" });

    const updated = store.update("real-id", { id: "hijacked", status: "paused" });

    // The targeted record keeps its id and absorbs the other updates …
    expect(updated.id).toBe("real-id");
    expect(updated.status).toBe("paused");
    // … and no record was created under the smuggled id.
    expect(store.load("hijacked")).toBeNull();
    expect(store.load("real-id").status).toBe("paused");
  });

  it("update() preserves the original createdAt while bumping updatedAt", () => {
    const saved = store.save({ id: "lineage", teamId: "t", status: "running" });
    const originalCreatedAt = saved.createdAt;

    const updated = store.update("lineage", { status: "done" });

    expect(updated.createdAt).toBe(originalCreatedAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(originalCreatedAt);
  });
});
