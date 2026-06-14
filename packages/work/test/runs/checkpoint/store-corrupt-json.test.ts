// Resilience tests for corrupt on-disk checkpoint files in
// packages/work/src/runs/checkpoint/store.ts.
//
// A checkpoint .json file can become unreadable — a crash mid-write before the
// atomic-rename era, external tampering, or a truncated copy. The store must
// degrade gracefully rather than throwing: load() returns null (and warns),
// and list() skips the bad file while still returning every valid record.
// The sibling artifact-store has this guard tested; the checkpoint store did
// not, so this pins the contract.
//
// Deterministic: all fs I/O lives in a tmp dir torn down in afterEach;
// console.warn is stubbed so the expected diagnostic does not pollute output.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

describe("checkpoint store: corrupt-JSON resilience", () => {
  let tmpRoot: string;
  let ckptDir: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-corrupt-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
    ckptDir = join(tmpRoot, "checkpoints");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("load() returns null (without throwing) for a corrupt checkpoint file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(ckptDir, "broken.json"), "{ not valid json {{");

    expect(store.load("broken")).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("list() skips a corrupt file and still returns the valid records", () => {
    store.save({ id: "good-1", teamId: "t", status: "running" });
    store.save({ id: "good-2", teamId: "t", status: "paused" });
    // Drop a garbage file directly into the dir alongside the valid ones.
    writeFileSync(join(ckptDir, "corrupt.json"), "}{ truncated");

    const ids = store.list().map((c: any) => c.id).sort();
    expect(ids).toEqual(["good-1", "good-2"]);
  });
});
