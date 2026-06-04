// workflow-engine unit tests — evaluateCondition, MAX_STEPS / MAX_CONCURRENT_RUNS constants,
// loadRun, and listRuns.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import {
  evaluateCondition,
  MAX_STEPS,
  MAX_CONCURRENT_RUNS,
  loadRun,
  listRuns,
} from "@zana-ai/work/src/scheduling/workflow-engine.ts";

// workspace-context has two module instances under vitest: the TS-source import
// above and the dist CJS one reached via require("@zana-ai/core") inside the
// production code.  Both singletons must be reset together between tests or the
// dist singleton keeps pointing at the real project's .zana directory.
const wcDist: any = (core as any).project.workspaceContext;
function resetWorkspace() {
  for (const wc of [workspaceContext as any, wcDist]) {
    try { if (typeof wc._resetForTesting === "function") wc._resetForTesting(); } catch {}
  }
}
function initWorkspace(root: string) {
  for (const wc of [workspaceContext as any, wcDist]) {
    try { wc.init(root); } catch {}
  }
}

describe("evaluateCondition", () => {
  it("returns true when condition is null/undefined (no gate)", () => {
    expect(evaluateCondition(null, {})).toBe(true);
    expect(evaluateCondition(undefined, {})).toBe(true);
    expect(evaluateCondition("", {})).toBe(true);
  });

  it("evaluates a truthy JS expression", () => {
    expect(evaluateCondition("1 === 1", {})).toBe(true);
    expect(evaluateCondition("ticket.status === 'done'", { ticket: { status: "done" } })).toBe(true);
  });

  it("evaluates a falsy JS expression", () => {
    expect(evaluateCondition("false", {})).toBe(false);
    expect(evaluateCondition("ticket.status === 'done'", { ticket: { status: "open" } })).toBe(false);
  });

  it("coerces truthy values to boolean", () => {
    expect(evaluateCondition("42", {})).toBe(true);
    expect(evaluateCondition("0", {})).toBe(false);
    expect(evaluateCondition("'hello'", {})).toBe(true);
  });

  it("exposes ticket, agent, run as top-level vars", () => {
    const ctx = {
      ticket: { priority: "high" },
      agent: { id: "a1" },
      run: { step: 3 },
    };
    expect(evaluateCondition("ticket.priority === 'high'", ctx)).toBe(true);
    expect(evaluateCondition("agent.id === 'a1'", ctx)).toBe(true);
    expect(evaluateCondition("run.step > 2", ctx)).toBe(true);
  });

  it("treats missing context properties as empty objects (no throw)", () => {
    // ticket/agent/run default to {} when not provided
    expect(evaluateCondition("ticket.foo === undefined", {})).toBe(true);
    expect(evaluateCondition("agent.bar === undefined", {})).toBe(true);
  });

  it("returns false when the expression throws (invalid syntax / runtime error)", () => {
    expect(evaluateCondition("this is not valid js!!!", {})).toBe(false);
    expect(evaluateCondition("null.property", {})).toBe(false);
  });
});

describe("exported constants", () => {
  it("MAX_STEPS is a positive integer (guards against runaway workflows)", () => {
    expect(typeof MAX_STEPS).toBe("number");
    expect(Number.isInteger(MAX_STEPS)).toBe(true);
    expect(MAX_STEPS).toBeGreaterThan(0);
  });

  it("MAX_CONCURRENT_RUNS is a positive integer", () => {
    expect(typeof MAX_CONCURRENT_RUNS).toBe("number");
    expect(Number.isInteger(MAX_CONCURRENT_RUNS)).toBe(true);
    expect(MAX_CONCURRENT_RUNS).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadRun / listRuns — disk persistence helpers
// ─────────────────────────────────────────────────────────────────────────────

const TEST_WS = path.join(os.tmpdir(), `zana-test-wfe-${Date.now()}-${process.pid}`);

function workflowsDir() {
  return path.join(workspaceContext.getProjectPaths().projectDir, "workflows");
}

function seedRun(id: string, status = "completed") {
  const dir = workflowsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, status, skillId: "s1" }, null, 2),
    "utf8",
  );
}

describe("loadRun", () => {
  beforeEach(() => {
    resetWorkspace();
    // Pre-create the .zana dir so resolveProjectDir anchors here and does not
    // walk up to /tmp/.zana (the global Zana state dir that exists on this host).
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
  });
  afterEach(() => {
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("returns null for a non-existent run id", () => {
    expect(loadRun("does-not-exist")).toBeNull();
  });

  it("returns the stored run object for a valid id", () => {
    seedRun("run-abc");
    const run = loadRun("run-abc");
    expect(run).not.toBeNull();
    expect(run.id).toBe("run-abc");
    expect(run.status).toBe("completed");
  });
});

describe("listRuns", () => {
  beforeEach(() => {
    resetWorkspace();
    // Pre-create the .zana dir so resolveProjectDir anchors here and does not
    // walk up to /tmp/.zana (the global Zana state dir that exists on this host).
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
  });
  afterEach(() => {
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("returns empty array when no run files exist", () => {
    expect(listRuns()).toEqual([]);
  });

  it("returns all run objects when no filter is applied", () => {
    seedRun("r1", "completed");
    seedRun("r2", "failed");
    const runs = listRuns();
    expect(runs.length).toBe(2);
    expect(runs.map((r: any) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("filters by status", () => {
    seedRun("r3", "completed");
    seedRun("r4", "failed");
    const completed = listRuns({ status: "completed" } as any);
    expect(completed.length).toBe(1);
    expect(completed[0].id).toBe("r3");

    const failed = listRuns({ status: "failed" } as any);
    expect(failed.length).toBe(1);
    expect(failed[0].id).toBe("r4");
  });
});
