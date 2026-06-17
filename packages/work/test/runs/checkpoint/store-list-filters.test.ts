// Tests the filtering, expiry, and ordering logic of list() in
// packages/work/src/runs/checkpoint/store.ts: composing field filters
// (teamId/runId/status/kind), dropping expired records by default while
// surfacing them under includeExpired, never expiring records that lack
// expiresAt (legacy compat), and sorting by updatedAt descending. The sibling
// corrupt-JSON test covers resilience; this pins the query contract.
// Deterministic: all fs I/O lives in a tmp dir torn down in afterEach.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";

describe("checkpoint store: list() filters, expiry, ordering", () => {
  let tmpRoot: string;
  let ckptDir: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-list-"));
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

  it("filters compose: teamId + runId + status + kind all must match", () => {
    store.save({ id: "match", teamId: "t1", runId: "r1", status: "running", kind: "run" });
    store.save({ id: "wrong-team", teamId: "t2", runId: "r1", status: "running", kind: "run" });
    store.save({ id: "wrong-run", teamId: "t1", runId: "r2", status: "running", kind: "run" });
    store.save({ id: "wrong-status", teamId: "t1", runId: "r1", status: "paused", kind: "run" });
    store.save({ id: "wrong-kind", teamId: "t1", runId: "r1", status: "running", kind: "deliberation" });

    const ids = store
      .list({ teamId: "t1", runId: "r1", status: "running", kind: "run" })
      .map((c: any) => c.id);

    expect(ids).toEqual(["match"]);
  });

  it("excludes records whose expiresAt is in the past by default", () => {
    const now = Date.now();
    store.save({ id: "fresh", status: "running", expiresAt: now + 60_000 });
    store.save({ id: "expired", status: "running", expiresAt: now - 60_000 });
    store.save({ id: "no-expiry", status: "running" });

    const ids = store.list().map((c: any) => c.id).sort();
    // expired dropped; fresh and the legacy (no expiresAt) record survive.
    expect(ids).toEqual(["fresh", "no-expiry"]);
  });

  it("surfaces expired records when includeExpired:true is passed", () => {
    const now = Date.now();
    store.save({ id: "fresh", status: "running", expiresAt: now + 60_000 });
    store.save({ id: "expired", status: "running", expiresAt: now - 60_000 });

    const ids = store.list({ includeExpired: true }).map((c: any) => c.id).sort();
    expect(ids).toEqual(["expired", "fresh"]);
  });

  it("returns results sorted by updatedAt descending", () => {
    // save()/update() both stamp updatedAt = Date.now(), so they can't pin a
    // deterministic ordering. Write the files directly with fixed updatedAt
    // values to assert the sort contract without depending on the wall clock.
    const writeCp = (id: string, updatedAt: number) =>
      writeFileSync(
        join(ckptDir, `${id}.json`),
        JSON.stringify({ id, status: "running", kind: "run", updatedAt }),
      );
    writeCp("oldest", 1000);
    writeCp("newest", 3000);
    writeCp("middle", 2000);

    const ids = store.list().map((c: any) => c.id);
    expect(ids).toEqual(["newest", "middle", "oldest"]);
  });
});
