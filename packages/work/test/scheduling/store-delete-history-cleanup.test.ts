// Tests that deleteSchedule also removes the schedule's run-history file, so a
// schedule later recreated under the same id does not inherit stale history.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContextTs from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/work/src/scheduling/store.ts";

const wcDist: any = (core as any).project?.workspaceContext ?? (core as any).default?.project?.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (wc && typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

function initWorkspace(root: string) {
  mkdirSync(join(root, ".zana"), { recursive: true });
  workspaceContextTs.init(root);
  if (wcDist && typeof wcDist.init === "function") wcDist.init(root);
}

describe("deleteSchedule — run-history cleanup", () => {
  let tmpRoot: string;

  function schedulerDir() {
    return wcDist.getProjectPaths().schedulerDir as string;
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-sched-del-hist-"));
    initWorkspace(tmpRoot);
  });

  afterEach(() => {
    resetWorkspace();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("removes the <id>.history.json file so a recreated schedule starts with empty history", () => {
    store.saveScheduleYaml({ id: "del-hist", every: "1h" });
    store.appendRunResult("del-hist", { runAt: "t1", agentId: "agent-1", status: "ok" });

    const historyFile = join(schedulerDir(), "del-hist.history.json");
    expect(existsSync(historyFile)).toBe(true);

    store.deleteSchedule("del-hist");

    // Both the schedule and its history file are gone.
    expect(store.getSchedule("del-hist")).toBeNull();
    expect(existsSync(historyFile)).toBe(false);
    // A recreated same-id schedule does not inherit the old run history.
    store.saveScheduleYaml({ id: "del-hist", every: "1h" });
    expect(store.getRunHistory("del-hist")).toEqual([]);
  });
});
