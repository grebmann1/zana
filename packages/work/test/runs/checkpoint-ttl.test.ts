import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana/core/src/project/workspace-context.ts";
import * as core from "@zana/core";

describe("checkpoint store: kind + expiresAt TTL", () => {
  let tmpRoot: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-ttl-"));
    // FU-T4c — kind=deliberation saves require an initialized workspace
    // context; init both module instances (TS-imported and dist-resolved)
    // because store.ts reaches @zana/core via require() which resolves to
    // dist while this test file imports the .ts source directly.
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    // init(tmpRoot) resets module-level `checkpointsDir` between tests.
    store = await import("@zana/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
  });

  afterEach(() => {
    // T5x-cross-proc — ordinary ops must not leave .tmp.* or .lock orphans.
    try {
      const entries = readdirSync(join(tmpRoot, "checkpoints"));
      const tmp = entries.filter((f) => f.includes(".tmp."));
      const lock = entries.filter((f) => f.endsWith(".lock"));
      expect(tmp).toEqual([]);
      expect(lock).toEqual([]);
    } catch {
      // checkpoints dir may not exist for some early-failure paths; ignore.
    }
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("loads pre-existing checkpoints with no kind/expiresAt unchanged (backward compat)", () => {
    // Simulate a legacy file written before kind/expiresAt existed.
    const legacy = {
      id: "legacy-1",
      teamId: "t",
      runId: "r",
      status: "active",
      createdAt: 1000,
      updatedAt: 2000,
    };
    writeFileSync(join(tmpRoot, "checkpoints", "legacy-1.json"), JSON.stringify(legacy));
    const loaded = store.load("legacy-1");
    expect(loaded).toEqual(legacy);
    expect(loaded.kind).toBeUndefined();
    expect(loaded.expiresAt).toBeUndefined();

    // It should never get swept because expiresAt is absent.
    const swept = store.sweepExpired();
    expect(swept.removed).toEqual([]);
    expect(store.load("legacy-1")).toEqual(legacy);
  });

  it("save without kind defaults to 'run'", () => {
    const cp = store.save({ teamId: "t" });
    expect(cp.kind).toBe("run");
  });

  it("list omits expired records by default; includeExpired:true returns them", () => {
    const past = Date.now() - 60_000;
    store.save({ id: "exp-1", kind: "deliberation", expiresAt: past });
    store.save({ id: "live-1", kind: "deliberation", expiresAt: Date.now() + 60_000 });

    const live = store.list();
    expect(live.map((r: any) => r.id).sort()).toEqual(["live-1"]);

    const all = store.list({ includeExpired: true });
    expect(all.map((r: any) => r.id).sort()).toEqual(["exp-1", "live-1"]);
  });

  it("sweepExpired removes only past-expiry records, leaves the rest", () => {
    const past = Date.now() - 1000;
    const future = Date.now() + 60_000;
    store.save({ id: "past", kind: "deliberation", expiresAt: past });
    store.save({ id: "future", kind: "deliberation", expiresAt: future });
    store.save({ id: "no-ttl", kind: "run" });

    const result = store.sweepExpired();
    expect(result.removed).toEqual(["past"]);
    expect(store.load("past")).toBeNull();
    expect(store.load("future")).not.toBeNull();
    expect(store.load("no-ttl")).not.toBeNull();
  });

  it("sweepExpired called twice is idempotent (second returns empty array)", () => {
    store.save({ id: "past", kind: "deliberation", expiresAt: Date.now() - 1000 });
    store.save({ id: "future", kind: "deliberation", expiresAt: Date.now() + 60_000 });

    const first = store.sweepExpired();
    expect(first.removed).toEqual(["past"]);

    const second = store.sweepExpired();
    expect(second.removed).toEqual([]);
  });

  it("addCompletedAgent on a legacy checkpoint silently injects kind='run', leaves expiresAt undefined", () => {
    // Legacy on-disk record predating kind/expiresAt fields.
    const legacy = {
      id: "legacy-mut",
      teamId: "t",
      runId: "r",
      status: "active",
      createdAt: 1000,
      updatedAt: 2000,
    };
    writeFileSync(join(tmpRoot, "checkpoints", "legacy-mut.json"), JSON.stringify(legacy));

    const before = store.load("legacy-mut");
    expect(before.kind).toBeUndefined();
    expect(before.expiresAt).toBeUndefined();

    store.addCompletedAgent("legacy-mut", {
      agentId: "a1",
      profileId: "p1",
      profileName: "researcher",
      result: "ok",
    });

    const after = store.load("legacy-mut");
    // save() defaults missing kind to "run" — silent normalization on first mutation.
    expect(after.kind).toBe("run");
    // expiresAt is left untouched (no TTL retroactively assigned).
    expect(after.expiresAt).toBeUndefined();
    expect(after.completedAgents).toHaveLength(1);
    expect(after.completedAgents[0].agentId).toBe("a1");
  });

  it("addPendingAgent on a legacy checkpoint also injects kind='run', leaves expiresAt undefined", () => {
    const legacy = {
      id: "legacy-pend",
      teamId: "t",
      runId: "r",
      status: "active",
      createdAt: 1000,
      updatedAt: 2000,
    };
    writeFileSync(join(tmpRoot, "checkpoints", "legacy-pend.json"), JSON.stringify(legacy));

    store.addPendingAgent("legacy-pend", { profileId: "p1", prompt: "do x" });

    const after = store.load("legacy-pend");
    expect(after.kind).toBe("run");
    expect(after.expiresAt).toBeUndefined();
    expect(after.pendingAgents).toHaveLength(1);
  });

  it("filter.kind returns only matching kinds", () => {
    store.save({ id: "d1", kind: "deliberation" });
    store.save({ id: "d2", kind: "deliberation" });
    store.save({ id: "r1", kind: "run" });
    store.save({ id: "r2" }); // defaults to "run"

    const delibs = store.list({ kind: "deliberation" });
    expect(delibs.map((r: any) => r.id).sort()).toEqual(["d1", "d2"]);

    const runs = store.list({ kind: "run" });
    expect(runs.map((r: any) => r.id).sort()).toEqual(["r1", "r2"]);
  });
});
