// Tenant-isolation gate for runs/store.ts (wave-1 council blocker fix).
//
// saveRun / deleteRun MUST throw WorkspaceNotInitializedError when the
// workspace context is not initialized. They were previously falling back
// to ~/.zana/runs/, which is shared across every workspace on the host —
// so workspace B could observe and modify workspace A's run records.
// Reads (getRun / listRuns) intentionally remain tolerant of the global
// fallback so legacy host-global runs stay inspectable.
//
// Pattern mirrors test/runs/tenant-isolation.test.ts (CAS + checkpoint).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContextTs from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as runsStore from "@zana-ai/work/src/runs/store.ts";

// Pull the class from the dist instance — that is the one production code
// throws. The .ts-imported instance has its own class object; an instanceof
// against it would fail even though the error name/code match.
const WorkspaceNotInitializedError = (core as any).project.workspaceContext
  .WorkspaceNotInitializedError;
const wcDist: any = (core as any).project.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (wc && typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

function initWorkspace(root: string) {
  // Pre-create .zana/ so resolveProjectDir stops at the tmp root and does
  // NOT walk up to /tmp/.zana (cross-test bleed risk).
  fs.mkdirSync(path.join(root, ".zana"), { recursive: true });
  workspaceContextTs.init(root);
  if (wcDist && typeof wcDist.init === "function") wcDist.init(root);
}

describe("runs/store tenant-isolation gate", () => {
  let tmpRoot: string;

  beforeEach(() => {
    resetWorkspace();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-runs-iso-"));
  });

  afterEach(() => {
    resetWorkspace();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("saveRun throws WorkspaceNotInitializedError when uninitialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    let caught: any = null;
    try {
      runsStore.saveRun({ id: "leak-attempt", status: "running", startedAt: Date.now() });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(WorkspaceNotInitializedError);
    expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
    expect(caught.operation).toBe("saveRun");
  });

  it("deleteRun throws WorkspaceNotInitializedError when uninitialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    let caught: any = null;
    try {
      runsStore.deleteRun("anything");
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(WorkspaceNotInitializedError);
    expect(caught.operation).toBe("deleteRun");
  });

  it("saveRun writes under .zana/runs/ when workspace is initialized", () => {
    initWorkspace(tmpRoot);
    const run = { id: "ok-run", status: "running", startedAt: Date.now() };
    runsStore.saveRun(run);

    const expected = path.join(tmpRoot, ".zana", "runs", "ok-run.json");
    expect(fs.existsSync(expected)).toBe(true);
    const back = runsStore.getRun("ok-run");
    expect(back).not.toBeNull();
    expect(back.id).toBe("ok-run");
  });

  it("cross-tenant runs are invisible — switching workspace hides the other tenant's runs", () => {
    // Tenant A — write a run.
    initWorkspace(tmpRoot);
    runsStore.saveRun({ id: "tenant-a-only", status: "running", startedAt: Date.now() });
    expect(runsStore.getRun("tenant-a-only")?.id).toBe("tenant-a-only");

    // Pivot to tenant B — fresh workspace root, fresh .zana/.
    resetWorkspace();
    const tmpRootB = fs.mkdtempSync(path.join(os.tmpdir(), "zana-runs-iso-b-"));
    try {
      initWorkspace(tmpRootB);
      // Tenant B cannot see tenant A's run by id…
      expect(runsStore.getRun("tenant-a-only")).toBeNull();
      // …nor in listRuns.
      const list = runsStore.listRuns();
      expect(list.find((r: any) => r.id === "tenant-a-only")).toBeUndefined();
    } finally {
      try { fs.rmSync(tmpRootB, { recursive: true, force: true }); } catch {}
    }
  });
});
