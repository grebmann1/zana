// Ordering invariant for runs/store.ts: the falsy-id short-circuit runs
// BEFORE the workspace-write gate.
//
// store.ts deleteRun() does `if (!id) return false;` ahead of
// assertWorkspaceForWrite("deleteRun"), and getRun() does `if (!id) return
// null;` ahead of any fs access. So a null/empty id must resolve to a quiet
// false/null even when NO workspace is initialized — it must NOT throw
// WorkspaceNotInitializedError.
//
// The sibling runs-store-tenant-isolation.test.ts only exercises the truthy-id
// throw path (deleteRun("anything")); store.test.ts only exercises null-id
// WITH a workspace initialized. This pins the uninitialized + falsy-id corner
// where those two guards interact.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as core from "@zana-ai/core";
import * as workspaceContextTs from "@zana-ai/contracts";
import * as runsStore from "@zana-ai/work/src/runs/store.ts";

const wcDist: any = (core as any).project.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (wc && typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

describe("runs/store — falsy id short-circuits before the workspace-write gate", () => {
  beforeEach(() => {
    resetWorkspace();
  });

  afterEach(() => {
    resetWorkspace();
  });

  it("deleteRun(null) returns false (does not throw) when uninitialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    expect(() => runsStore.deleteRun(null as any)).not.toThrow();
    expect(runsStore.deleteRun(null as any)).toBe(false);
  });

  it("deleteRun(\"\") returns false (does not throw) when uninitialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    expect(() => runsStore.deleteRun("")).not.toThrow();
    expect(runsStore.deleteRun("")).toBe(false);
  });

  it("getRun(null) returns null (does not throw) when uninitialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    expect(() => runsStore.getRun(null as any)).not.toThrow();
    expect(runsStore.getRun(null as any)).toBeNull();
  });

  it("a truthy id still trips the gate — proving the guard, not the gate, is what spared the falsy calls", () => {
    expect(wcDist.isInitialized()).toBe(false);
    // Contrast case: with a real id, deleteRun MUST reach assertWorkspaceForWrite and throw.
    expect(() => runsStore.deleteRun("real-id")).toThrow();
  });
});
