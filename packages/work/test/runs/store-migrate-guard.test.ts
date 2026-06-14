// Regression pin for the `migrateRun` guard conditions in runs/store.ts.
//
// migrateRun has two migration guards:
//
//   1. hiveId → daemonId  (lines 38-41)
//      Condition: `run.hiveId !== undefined && run.daemonId === undefined`
//      Guard: if `daemonId` already exists, do NOT clobber it with `hiveId`.
//
//   2. subHives → subDaemons  (lines 42-45)
//      Condition: `Array.isArray(run.subHives) && !Array.isArray(run.subDaemons)`
//      Guard: if `subDaemons` already exists, do NOT clobber it with `subHives`.
//
// Existing tests (store.test.ts) only cover the "absent → migrate" path.
// These tests cover the opposite: "both present → leave daemonId / subDaemons intact".
//
// No real network or time dependency — deterministic disk I/O under a tmpdir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import { getRun, saveRun, listRuns } from "@zana-ai/work/src/runs/store.ts";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-runs-store-migrate-guard-${Date.now()}-${process.pid}`,
);

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    daemonId: "default",
    workspace: TEST_WORKSPACE,
    teamId: "team-1",
    teamName: "Team",
    status: "completed",
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

describe("runs/store — migrateRun guard: both fields coexist", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  describe("hiveId + daemonId coexistence — daemonId takes priority", () => {
    it("getRun does NOT overwrite an existing daemonId with hiveId when both are present", () => {
      // Simulate a partially-migrated or double-written record where both fields exist.
      const run = makeRun({ daemonId: "real-daemon", id: "run-both-1" });
      const withBoth = { ...run, hiveId: "old-hive" };
      saveRun(withBoth as any);

      const loaded = getRun("run-both-1")!;
      // daemonId must be preserved — NOT replaced by hiveId.
      expect(loaded.daemonId).toBe("real-daemon");
    });

    it("getRun leaves hiveId intact when daemonId is already present (no delete on non-migrating path)", () => {
      const run = makeRun({ daemonId: "daemon-a", id: "run-both-2" });
      const withBoth = { ...run, hiveId: "hive-x" };
      saveRun(withBoth as any);

      const loaded = getRun("run-both-2") as any;
      // Because the migration guard did not fire, hiveId survives as-is.
      expect((loaded as any).hiveId).toBe("hive-x");
    });

    it("listRuns also preserves daemonId when both fields coexist", () => {
      const run = makeRun({ daemonId: "daemon-b", id: "run-both-3" });
      saveRun({ ...run, hiveId: "stale-hive" } as any);

      const list = listRuns({});
      const found = list.find((r: any) => r.id === "run-both-3") as any;
      expect(found).toBeDefined();
      expect(found.daemonId).toBe("daemon-b");
    });
  });

  describe("subHives + subDaemons coexistence — subDaemons takes priority", () => {
    it("getRun does NOT overwrite existing subDaemons with subHives when both are present", () => {
      const run = makeRun({ subDaemons: ["d1", "d2"], id: "run-both-4" });
      const withBoth = { ...run, subHives: ["old-h1", "old-h2"] };
      saveRun(withBoth as any);

      const loaded = getRun("run-both-4") as any;
      // subDaemons must be the real value — NOT replaced by subHives.
      expect(loaded.subDaemons).toEqual(["d1", "d2"]);
    });

    it("getRun leaves subHives intact when subDaemons is already an array", () => {
      const run = makeRun({ subDaemons: ["d3"], id: "run-both-5" });
      const withBoth = { ...run, subHives: ["h3"] };
      saveRun(withBoth as any);

      const loaded = getRun("run-both-5") as any;
      expect(loaded.subHives).toEqual(["h3"]);
    });
  });
});
