// Tests that listRuns() applies the same legacy-field migration that getRun() does,
// and that it silently skips files that cannot be parsed.
//
// store.test.ts covers the getRun migration paths; this file closes the gap for
// the listRuns code path — migrateRun is called inside the .map() in listRuns,
// so the path is independent of the getRun path and was previously untested.
//
// Deterministic — real FS under a tmp workspace, no network, no real Claude.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import { listRuns, saveRun } from "@zana-ai/work/src/runs/store.ts";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-list-migration-${Date.now()}-${process.pid}`,
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

describe("runs/store — listRuns legacy migration", () => {
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

  it("migrates hiveId → daemonId in records returned by listRuns", () => {
    const run = makeRun();
    const legacy: any = { ...run, hiveId: "hive-42" };
    delete legacy.daemonId;
    saveRun(legacy);

    const results = listRuns();
    const loaded = results.find((r: any) => r.id === run.id);
    expect(loaded).toBeDefined();
    expect(loaded!.daemonId).toBe("hive-42");
    expect((loaded as any).hiveId).toBeUndefined();
  });

  it("migrates subHives → subDaemons in records returned by listRuns", () => {
    const run = makeRun();
    const legacy: any = { ...run, subHives: ["d-a", "d-b"] };
    delete legacy.subDaemons;
    saveRun(legacy);

    const results = listRuns();
    const loaded = results.find((r: any) => r.id === run.id);
    expect(loaded).toBeDefined();
    expect(loaded!.subDaemons).toEqual(["d-a", "d-b"]);
    expect((loaded as any).subHives).toBeUndefined();
  });

  it("silently skips unparseable JSON files without throwing", () => {
    // Write a valid run first — this creates the runs dir as a side-effect.
    const sentinel = makeRun();
    saveRun(sentinel);

    const ctx = (core as any).project.workspaceContext;
    const runsDir = ctx.getProjectPaths().runsDir;
    fs.writeFileSync(path.join(runsDir, "corrupt.json"), ":not-json:", "utf8");

    // listRuns must not throw and must still include the valid run.
    expect(() => listRuns()).not.toThrow();
    const results = listRuns();
    expect(results.find((r: any) => r.id === sentinel.id)).toBeDefined();
    // Corrupt entry must have been filtered out (no null / non-object entries).
    expect(results.every((r: any) => r && typeof r === "object")).toBe(true);
  });
});
