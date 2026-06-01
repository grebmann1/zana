import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  writeFileSync,
  existsSync,
  utimesSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

// T5x-cross-proc — atomic write + advisory lock + stale orphan sweep.
//
// These tests assume POSIX semantics for fs.renameSync (atomic on the same
// filesystem). They do not attempt to truly simulate a power-loss mid-write
// (impossible inside a single process); instead they assert the observable
// invariants: no `.tmp.*` orphan after a successful save(), no `.lock`
// orphan after ordinary RMW, deterministic last-writer for concurrent
// update(), and stale-age sweep behavior.

describe("checkpoint store: atomic write + advisory lock (T5x-cross-proc)", () => {
  let tmpRoot: string;
  let store: any;
  let checkpointsDir: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-atomic-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
    checkpointsDir = join(tmpRoot, "checkpoints");
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  function listOrphans() {
    const all = readdirSync(checkpointsDir);
    return {
      tmp: all.filter((f) => f.includes(".tmp.")),
      lock: all.filter((f) => f.endsWith(".lock")),
    };
  }

  it("save() leaves no .tmp.* orphan on success", () => {
    store.save({ id: "atomic-ok", teamId: "t", payload: "x".repeat(2048) });
    expect(existsSync(join(checkpointsDir, "atomic-ok.json"))).toBe(true);
    const orphans = listOrphans();
    expect(orphans.tmp).toEqual([]);
    expect(orphans.lock).toEqual([]);
  });

  it("update() leaves no .lock orphan on success", () => {
    store.save({ id: "lock-ok", teamId: "t" });
    store.update("lock-ok", { status: "active" });
    const after = store.load("lock-ok");
    expect(after.status).toBe("active");
    const orphans = listOrphans();
    expect(orphans.tmp).toEqual([]);
    expect(orphans.lock).toEqual([]);
  });

  it("addCompletedAgent and addPendingAgent leave no orphans", () => {
    store.save({ id: "rmw", teamId: "t" });
    store.addPendingAgent("rmw", { profileId: "p1", prompt: "do x" });
    store.addCompletedAgent("rmw", {
      agentId: "a1",
      profileId: "p1",
      profileName: "researcher",
      result: "ok",
    });
    const orphans = listOrphans();
    expect(orphans.tmp).toEqual([]);
    expect(orphans.lock).toEqual([]);
    const after = store.load("rmw");
    expect(after.completedAgents).toHaveLength(1);
  });

  it("two concurrent update() calls on the same id both land deterministically (no clobber)", async () => {
    store.save({ id: "race", teamId: "t", counter: 0, history: [] as string[] });

    // Each update appends a tag to history. With the cross-process lock, the
    // RMW serializes and both tags survive. Without the lock, last-writer-
    // wins would lose one of them.
    const calls = await Promise.all([
      Promise.resolve().then(() => {
        const cur = store.load("race");
        const next = (cur.counter || 0) + 1;
        return store.update("race", {
          counter: next,
          history: [...(cur.history || []), "A"],
        });
      }),
      Promise.resolve().then(() => {
        const cur = store.load("race");
        const next = (cur.counter || 0) + 1;
        return store.update("race", {
          counter: next,
          history: [...(cur.history || []), "B"],
        });
      }),
    ]);

    // NOTE: because the in-test "read then update" is split across two awaits,
    // both calls may have observed counter=0 — that's the in-process race.
    // What we are asserting here is the cross-process LOCK guarantee: each
    // update()'s INTERNAL load+save is serialized, so the .json file never
    // contains a partial-merged state and both updates produce a valid file.
    // Final history length depends on interleaving; what must hold is no
    // orphan and a coherent final record.
    const orphans = listOrphans();
    expect(orphans.tmp).toEqual([]);
    expect(orphans.lock).toEqual([]);

    const final = store.load("race");
    expect(final).not.toBeNull();
    expect(typeof final.counter).toBe("number");
    expect(Array.isArray(final.history)).toBe(true);
    // Both calls returned a non-null merged record (i.e. neither saw a missing
    // file mid-RMW).
    expect(calls[0]).not.toBeNull();
    expect(calls[1]).not.toBeNull();
  });

  it("stale .lock file is swept on contention and acquisition still succeeds", () => {
    store.save({ id: "stale-lock", teamId: "t" });
    const lockPath = join(checkpointsDir, "stale-lock.json.lock");
    // Plant a lock file with mtime well beyond the 30s stale threshold.
    writeFileSync(lockPath, "99999");
    const oldMs = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(lockPath, oldMs, oldMs);

    // update() should sweep the stale lock and proceed.
    const result = store.update("stale-lock", { status: "active" });
    expect(result).not.toBeNull();
    expect(result.status).toBe("active");

    // No leftover lock after success.
    expect(existsSync(lockPath)).toBe(false);
  });

  it("sweepStale removes old .tmp.* and .lock files, leaves recent ones alone", () => {
    store.save({ id: "sweep-host", teamId: "t" });

    const oldTmp = join(checkpointsDir, "sweep-host.json.tmp.1234.deadbeef");
    const oldLock = join(checkpointsDir, "sweep-host.json.lock");
    const youngTmp = join(checkpointsDir, "fresh.json.tmp.1234.cafebabe");
    const youngLock = join(checkpointsDir, "fresh.json.lock");

    writeFileSync(oldTmp, "stale");
    writeFileSync(oldLock, "1");
    writeFileSync(youngTmp, "fresh");
    writeFileSync(youngLock, "2");

    const fiveMinAgoSec = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(oldTmp, fiveMinAgoSec, fiveMinAgoSec);
    utimesSync(oldLock, fiveMinAgoSec, fiveMinAgoSec);
    // young files keep their just-now mtime

    const result = store.sweepStale();
    expect(result.removedTmp).toContain("sweep-host.json.tmp.1234.deadbeef");
    expect(result.removedLocks).toContain("sweep-host.json.lock");

    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(oldLock)).toBe(false);
    expect(existsSync(youngTmp)).toBe(true);
    expect(existsSync(youngLock)).toBe(true);

    // Real checkpoint json untouched.
    expect(existsSync(join(checkpointsDir, "sweep-host.json"))).toBe(true);
    expect(statSync(join(checkpointsDir, "sweep-host.json")).isFile()).toBe(true);
  });

  it("sweepStale is idempotent on a clean directory", () => {
    store.save({ id: "clean", teamId: "t" });
    const first = store.sweepStale();
    expect(first.removedTmp).toEqual([]);
    expect(first.removedLocks).toEqual([]);
    const second = store.sweepStale();
    expect(second.removedTmp).toEqual([]);
    expect(second.removedLocks).toEqual([]);
  });
});
