// Lock-contention timeout path for packages/work/src/runs/checkpoint/store.ts.
//
// checkpoint-atomic.test.ts already covers the happy path (no .lock orphan)
// and the STALE-lock sweep (an old lockfile is reclaimed, acquisition then
// succeeds). The remaining uncovered branch in withFileLockSync is the
// contention TIMEOUT: a FRESH (non-stale) lockfile held by another process
// must NOT be swept, and the RMW caller must give up with a
// "checkpoint lock contention" error once timeoutMs elapses.
//
// Deterministic: we synthesize the contending lockfile directly on disk
// (simulating a sibling process mid-RMW). No real concurrency, no clock
// injection needed — the default 500ms timeout keeps the test well under a
// second and the lock's mtime is "now", so the stale sweep (30s threshold)
// can't reclaim it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

describe("checkpoint store: lock contention", () => {
  let tmpRoot: string;
  let checkpointsDir: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-lock-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
    checkpointsDir = join(tmpRoot, "checkpoints");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("update() throws 'checkpoint lock contention' when a fresh lock is held", () => {
    store.save({ id: "contend-1", teamId: "t1", status: "running" });

    // Simulate a sibling process holding the RMW lock right now. mtime is
    // "now", so it is younger than LOCK_STALE_MS and must not be swept.
    const lockPath = join(checkpointsDir, "contend-1.json.lock");
    writeFileSync(lockPath, "99999"); // a foreign pid

    expect(() => store.update("contend-1", { status: "paused" }))
      .toThrow("checkpoint lock contention");

    // The contender's lock is left intact — we never steal a live lock, and
    // the failed RMW must not delete a lock it does not own.
    expect(existsSync(lockPath)).toBe(true);

    // And the underlying record is untouched by the failed update.
    expect(store.load("contend-1").status).toBe("running");
  });
});
