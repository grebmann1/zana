// Regression test for the sweepStale() lock-orphan reclamation branch in
// packages/work/src/runs/checkpoint/store.ts.
//
// A daemon crash mid-RMW can leave a `.lock` file behind. On the next boot
// sweepStale() must reclaim any lockfile older than LOCK_STALE_MS (30s) and
// report it in `removedLocks`, while leaving a fresh lock (a live writer's)
// untouched. The existing sweep-stale-tmp-pattern suite only asserts that
// removedLocks stays EMPTY in the tmp-focused case — the actual lock-removal
// branch and the fresh-lock guard were never exercised.
//
// Deterministic: all fs I/O lives in a tmp dir torn down in afterEach; mtimes
// are pinned with utimesSync rather than real waiting.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

describe("checkpoint store: sweepStale lock-orphan reclamation", () => {
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

  it("sweeps a stale .lock orphan but leaves a fresh lock untouched", () => {
    const staleLock = join(checkpointsDir, "crashed.json.lock");
    const freshLock = join(checkpointsDir, "live.json.lock");
    writeFileSync(staleLock, "12345");
    writeFileSync(freshLock, String(process.pid));

    // Age the stale lock well past LOCK_STALE_MS (30s); leave the fresh lock
    // at its just-written mtime so it stays under the threshold.
    const longAgoSec = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(staleLock, longAgoSec, longAgoSec);

    const result = store.sweepStale();

    expect(result.removedLocks).toEqual(["crashed.json.lock"]);
    expect(result.removedTmp).toEqual([]);
    expect(existsSync(staleLock)).toBe(false);
    expect(existsSync(freshLock)).toBe(true);
  });
});
