// migrateRun's null-guard branch — a run file containing valid JSON `null`.
//
// store.ts migrateRun starts with `if (!run || typeof run !== "object") return run`.
// The existing "silently skips unparseable JSON" test writes `:not-json:`, which
// makes JSON.parse THROW — exercising the try/catch path, never migrateRun. A file
// containing valid JSON `null` is different: JSON.parse succeeds and returns null,
// so migrateRun(null) is invoked and the null-guard returns null. listRuns then
// drops it via `.filter(Boolean)`; getRun returns null. This pins that distinct,
// previously-untested branch. Deterministic — tmp workspace FS, no network/Claude.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import { listRuns, getRun, saveRun } from "@zana-ai/work/src/runs/store.ts";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-json-null-${process.pid}`,
);

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    status: "completed",
    startedAt: Date.now(),
    endedAt: Date.now() + 1_000,
    durationMs: 1_000,
    agents: [],
    tickets: { total: 0, completed: 0, ids: [] },
    filesProduced: [],
    subDaemons: [] as string[],
    stats: { totalAgents: 0, totalToolCalls: 0, toolBreakdown: {} },
    ...overrides,
  };
}

function runsDir(): string {
  return (core as any).project.workspaceContext.getProjectPaths().runsDir;
}

describe("runs/store — file containing valid JSON null", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    // Pre-create .zana/ so resolveProjectDir stops here and does NOT walk up
    // to a parent that may already have a .zana/ (e.g. /tmp/.zana/).
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  it("listRuns drops a parses-to-null record but keeps valid runs", () => {
    // saveRun creates the runs dir as a side-effect.
    const sentinel = makeRun();
    saveRun(sentinel);

    // Plant a file that is valid JSON but whose value is `null`.
    fs.writeFileSync(path.join(runsDir(), "null-run.json"), "null\n", "utf8");

    expect(() => listRuns()).not.toThrow();
    const results = listRuns();
    // The valid run survives.
    expect(results.find((r: any) => r.id === sentinel.id)).toBeDefined();
    // No null / non-object entry leaks through the filter.
    expect(results.every((r: any) => r && typeof r === "object")).toBe(true);
  });

  it("getRun returns null for a file whose contents are valid JSON null", () => {
    saveRun(makeRun()); // ensure the runs dir exists
    fs.writeFileSync(path.join(runsDir(), "ghost.json"), "null\n", "utf8");

    // Reaches migrateRun(null) without throwing; the null-guard returns null.
    expect(getRun("ghost")).toBeNull();
  });
});
