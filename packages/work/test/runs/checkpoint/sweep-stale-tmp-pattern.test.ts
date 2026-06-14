// Regression test for the sweepStale() tmp-pattern safety invariant in
// packages/work/src/runs/checkpoint/store.ts.
//
// sweepStale() only removes orphans matching the EXACT atomic-write tmp
// pattern (`<id>.json.tmp.<pid>.<hex>`). A legitimate checkpoint whose id
// merely contains ".tmp." (producing a file like `weird.tmp.json`) must NOT
// be deleted, even when its mtime is well past the stale threshold — the
// store comment explicitly guards this case. The existing checkpoint-atomic
// suite covers removal of real orphans and leaving recent ones alone, but not
// this false-positive guard.
//
// Deterministic: all fs I/O lives in a tmp dir torn down in afterEach; mtimes
// are pinned with utimesSync rather than real waiting.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

describe("checkpoint store: sweepStale tmp-pattern safety", () => {
  let tmpRoot: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-sweep-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("does not sweep a stale checkpoint whose id contains '.tmp.'", () => {
    // id "weird.tmp" → file "weird.tmp.json". This ends in .json (a real
    // checkpoint) and must never match the orphan tmp pattern.
    const saved = store.save({ id: "weird.tmp", teamId: "t", status: "running" });
    expect(saved.id).toBe("weird.tmp");

    const filePath = join(tmpRoot, "checkpoints", "weird.tmp.json");
    expect(existsSync(filePath)).toBe(true);

    // Age it far past both TMP (60s) and LOCK (30s) thresholds.
    const longAgoSec = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(filePath, longAgoSec, longAgoSec);

    const result = store.sweepStale();

    expect(result.removedTmp).toEqual([]);
    expect(result.removedLocks).toEqual([]);
    // The legit checkpoint survives and is still loadable.
    expect(existsSync(filePath)).toBe(true);
    expect(store.load("weird.tmp")).not.toBeNull();
  });
});
