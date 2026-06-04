// Tenant-isolation gate for scheduling/store.ts (wave-1 council blocker fix).
//
// Write entry points (ensureDir / saveSchedule / saveScheduleYaml /
// saveScheduleSameFormat / deleteSchedule / appendRunResult /
// updateRunResult) MUST throw WorkspaceNotInitializedError when the
// workspace context is not initialized — they were previously falling back
// to ~/.zana/scheduler, which is shared across every workspace on the host.
// Reads (listSchedules / getSchedule / getRunHistory) remain tolerant by
// design so legacy host-global schedules stay inspectable.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContextTs from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as schedStore from "@zana-ai/work/src/scheduling/store.ts";

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
  fs.mkdirSync(path.join(root, ".zana"), { recursive: true });
  workspaceContextTs.init(root);
  if (wcDist && typeof wcDist.init === "function") wcDist.init(root);
}

describe("scheduling/store tenant-isolation gate", () => {
  let tmpRoot: string;

  beforeEach(() => {
    resetWorkspace();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-sched-iso-"));
  });

  afterEach(() => {
    resetWorkspace();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("saveScheduleYaml throws WorkspaceNotInitializedError when uninitialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    let caught: any = null;
    try {
      schedStore.saveScheduleYaml({ id: "leak-sched", every: "5m" });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(WorkspaceNotInitializedError);
    expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
    expect(caught.operation).toBe("saveScheduleYaml");
  });

  it("saveSchedule (json) throws WorkspaceNotInitializedError when uninitialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    let caught: any = null;
    try {
      schedStore.saveSchedule({ id: "leak-sched-json", every: "5m" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceNotInitializedError);
    expect(caught.operation).toBe("saveSchedule");
  });

  it("appendRunResult throws WorkspaceNotInitializedError when uninitialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    let caught: any = null;
    try {
      schedStore.appendRunResult("any-id", { runAt: "now", agentId: "a", status: "ok" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceNotInitializedError);
    expect(caught.operation).toBe("appendRunResult");
  });

  it("deleteSchedule throws WorkspaceNotInitializedError when uninitialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    let caught: any = null;
    try {
      schedStore.deleteSchedule("any-id");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceNotInitializedError);
    expect(caught.operation).toBe("deleteSchedule");
  });

  it("ensureDir throws WorkspaceNotInitializedError when uninitialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    let caught: any = null;
    try {
      schedStore.ensureDir();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceNotInitializedError);
    expect(caught.operation).toBe("ensureDir");
  });

  it("saveScheduleYaml + appendRunResult write under .zana/scheduler/ post-init", () => {
    initWorkspace(tmpRoot);
    schedStore.saveScheduleYaml({ id: "ok-sched", every: "1h" });
    const yamlPath = path.join(tmpRoot, ".zana", "scheduler", "ok-sched.yml");
    expect(fs.existsSync(yamlPath)).toBe(true);

    schedStore.appendRunResult("ok-sched", {
      runAt: "2024-01-01T00:00:00Z",
      agentId: "agent-A",
      status: "ok",
    });
    const histPath = path.join(tmpRoot, ".zana", "scheduler", "ok-sched.history.json");
    expect(fs.existsSync(histPath)).toBe(true);
    const history = schedStore.getRunHistory("ok-sched");
    expect(history).toHaveLength(1);
    expect(history[0].agentId).toBe("agent-A");
  });

  it("listSchedules remains tolerant when uninitialized (read-side fallback)", () => {
    // Read-side is intentionally permissive — it shouldn't throw, just
    // walk the global ~/.zana/scheduler dir. We redirect HOME to the
    // per-test tmpRoot (an empty dir) so os.homedir() doesn't resolve to
    // the real home where thousands of schedule files could cause a timeout.
    const origHome = process.env.HOME;
    process.env.HOME = tmpRoot;
    try {
      expect(wcDist.isInitialized()).toBe(false);
      let threw: any = null;
      let result: any;
      try {
        result = schedStore.listSchedules();
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeNull();
      expect(Array.isArray(result)).toBe(true);
    } finally {
      process.env.HOME = origHome;
    }
  });
});
