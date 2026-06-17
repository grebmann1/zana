import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import { listRuns, getRun, saveRun, deleteRun } from "@zana-ai/work/src/runs/store.ts";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-runs-store-${Date.now()}-${process.pid}`
);

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    daemonId: "default",
    workspace: TEST_WORKSPACE,
    teamId: "team-1",
    teamName: "Alpha Team",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    agents: [],
    tickets: { total: 0, completed: 0, ids: [] },
    filesProduced: [],
    subDaemons: [],
    stats: { totalAgents: 0, totalToolCalls: 0, toolBreakdown: {} },
    ...overrides,
  };
}

describe("runs/store", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    // Pre-create .zana/ so resolveProjectDir stops here instead of walking up
    // to a parent directory that may already have a .zana/ (e.g. /tmp/.zana/).
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  // ── saveRun / getRun ──────────────────────────────────────────────────────

  it("saveRun persists a run and getRun returns it", () => {
    const run = makeRun({ status: "completed" });
    saveRun(run);
    const loaded = getRun(run.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(run.id);
    expect(loaded!.status).toBe("completed");
  });

  it("getRun returns null for an unknown id", () => {
    expect(getRun("does-not-exist")).toBeNull();
  });

  it("getRun returns null for null or empty id", () => {
    expect(getRun(null as any)).toBeNull();
    expect(getRun("")).toBeNull();
  });

  // ── deleteRun ─────────────────────────────────────────────────────────────

  it("deleteRun removes the JSON file and returns true", () => {
    const run = makeRun();
    saveRun(run);
    expect(deleteRun(run.id)).toBe(true);
    expect(getRun(run.id)).toBeNull();
  });

  it("deleteRun returns false for a non-existent id", () => {
    expect(deleteRun("ghost-run")).toBe(false);
  });

  it("deleteRun returns false for null id", () => {
    expect(deleteRun(null as any)).toBe(false);
  });

  // ── listRuns ──────────────────────────────────────────────────────────────

  it("listRuns returns saved runs sorted newest-first", () => {
    const older = makeRun({ startedAt: 1_000_000 });
    const newer = makeRun({ startedAt: 2_000_000 });
    saveRun(older);
    saveRun(newer);
    const runs = listRuns();
    expect(runs.length).toBeGreaterThanOrEqual(2);
    const ids = runs.map((r) => r.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
  });

  it("listRuns filters by status", () => {
    saveRun(makeRun({ status: "completed" }));
    saveRun(makeRun({ status: "running" }));
    const completed = listRuns({ status: "completed" });
    expect(completed.every((r) => r.status === "completed")).toBe(true);
  });

  it("listRuns respects limit and offset", () => {
    for (let i = 0; i < 5; i++) saveRun(makeRun({ startedAt: i * 1000 }));
    const page1 = listRuns({ limit: 2, offset: 0 });
    const page2 = listRuns({ limit: 2, offset: 2 });
    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page1.map((r) => r.id)).not.toEqual(page2.map((r) => r.id));
  });

  it("listRuns returns empty array when no runs exist", () => {
    expect(listRuns()).toEqual([]);
  });

  // ── migrateRun (legacy field rename) ─────────────────────────────────────

  it("getRun migrates hiveId → daemonId on legacy records", () => {
    const run = makeRun();
    const legacy = { ...run, hiveId: "hive-42" };
    delete (legacy as any).daemonId;
    saveRun(legacy as any);

    const loaded = getRun(run.id);
    expect(loaded!.daemonId).toBe("hive-42");
    expect((loaded as any).hiveId).toBeUndefined();
  });

  it("getRun migrates subHives → subDaemons on legacy records", () => {
    const run = makeRun();
    const legacy = { ...run, subHives: ["daemon-a", "daemon-b"], subDaemons: undefined };
    saveRun(legacy as any);

    const loaded = getRun(run.id);
    expect(loaded!.subDaemons).toEqual(["daemon-a", "daemon-b"]);
    expect((loaded as any).subHives).toBeUndefined();
  });
});
