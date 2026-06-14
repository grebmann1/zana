// Tests for the checkpoint store list({ kind }) filter — the one list()
// filter parameter (store.ts: `if (filter.kind && data.kind !== filter.kind)`)
// not exercised by checkpoint-list-filters.test.ts (teamId/runId/status) or
// checkpoint-ttl.test.ts (includeExpired).
//
// No real network or clock dependency — all fs I/O goes into a tmp dir torn
// down in afterEach. The workspace context is initialised so kind="deliberation"
// saves pass the tenant-isolation gate.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

describe("checkpoint store: list({ kind }) filter", () => {
  let tmpRoot: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-kind-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("list({ kind: 'deliberation' }) returns only deliberation checkpoints", () => {
    store.save({ id: "k-run", status: "running" }); // defaults to kind="run"
    store.save({ id: "k-delib", kind: "deliberation", status: "running" });

    const result = store.list({ kind: "deliberation" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("k-delib");
    expect(result[0].kind).toBe("deliberation");
  });

  it("list({ kind: 'run' }) excludes deliberation checkpoints", () => {
    store.save({ id: "k-run-a", status: "running" });
    store.save({ id: "k-run-b", kind: "run", status: "done" });
    store.save({ id: "k-delib-2", kind: "deliberation", status: "running" });

    const result = store.list({ kind: "run" });
    expect(result.map((c: any) => c.id).sort()).toEqual(["k-run-a", "k-run-b"]);
  });

  it("list() with no kind filter returns checkpoints of every kind", () => {
    store.save({ id: "any-run", status: "running" });
    store.save({ id: "any-delib", kind: "deliberation", status: "running" });

    const ids = store.list().map((c: any) => c.id);
    expect(ids).toContain("any-run");
    expect(ids).toContain("any-delib");
  });
});
