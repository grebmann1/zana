// Focused edge test for scheduling/store.updateRunResult(): when the SAME
// agentId appears in more than one history entry, the backward scan
// (for (let i = history.length - 1; i >= 0; i--)) must patch the MOST RECENT
// occurrence and leave the older one untouched. store.test.ts only exercises
// distinct agentIds, so this last-write-wins behavior is documented in the
// source ("Matches the most recent history entry whose agentId equals ...")
// but never actually asserted.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContextTs from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/work/src/scheduling/store.ts";

const wcDist: any =
  (core as any).project?.workspaceContext ?? (core as any).default?.project?.workspaceContext;

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

describe("scheduling/store — updateRunResult with a repeated agentId", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-sched-dup-agent-"));
    initWorkspace(tmpRoot);
  });

  afterEach(() => {
    resetWorkspace();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("patches the last occurrence and leaves the earlier same-agentId entry untouched", () => {
    store.saveScheduleYaml({ id: "dup", every: "1h" });
    // Two stubs for the SAME agentId (e.g. a re-fired run reusing the id),
    // plus an unrelated entry in between to prove the scan is by-agentId, not
    // just "last entry".
    store.appendRunResult("dup", { runAt: "t1", agentId: "agent-A", status: "running" });
    store.appendRunResult("dup", { runAt: "t2", agentId: "agent-B", status: "running" });
    store.appendRunResult("dup", { runAt: "t3", agentId: "agent-A", status: "running" });

    const patched = store.updateRunResult("dup", "agent-A", {
      status: "done",
      summary: "second run finished",
    });

    // The returned entry is the most recent agent-A stub (runAt t3).
    expect(patched).not.toBeNull();
    expect(patched!.runAt).toBe("t3");
    expect(patched!.status).toBe("done");
    expect(patched!.summary).toBe("second run finished");

    const history = store.getRunHistory("dup");
    expect(history).toHaveLength(3);
    // Earlier agent-A stub (t1) is NOT modified.
    const first = history.find((h: any) => h.runAt === "t1");
    expect(first.status).toBe("running");
    expect(first.summary).toBeUndefined();
    // The intervening agent-B entry is untouched too.
    const middle = history.find((h: any) => h.runAt === "t2");
    expect(middle.agentId).toBe("agent-B");
    expect(middle.status).toBe("running");
  });
});
