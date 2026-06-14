// Edge-case tests for scheduling/store.ts that are not covered by store.test.ts.
//
// Two paths exercised here:
//   1. appendRunResult with history.retain === 0 — the "zero-retention" branch
//      (`!cfg.enabled || cfg.retain === 0`) that cleans up any stale history
//      file and returns [] without writing new entries.
//   2. updateRunResult when the history array is present but empty —
//      the early-exit guard `history.length === 0` that returns null.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContextTs from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/work/src/scheduling/store.ts";

// ── workspace helpers ──────────────────────────────────────────────────────

const wcDist: any = (core as any).project?.workspaceContext;

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

function histFile(root: string, id: string): string {
  return path.join(root, ".zana", "scheduler", `${id}.history.json`);
}

// ── fixtures ───────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-sched-zr-"));
  initWorkspace(tmpRoot);
});

afterEach(() => {
  resetWorkspace();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── appendRunResult — zero-retain path ────────────────────────────────────

describe("appendRunResult — history.retain === 0", () => {
  it("does not write a history file when retain is 0", () => {
    store.saveScheduleYaml({ id: "zr1", every: "5m", history: { enabled: true, retain: 0 } });
    const returned = store.appendRunResult("zr1", { runAt: "now", agentId: "a1", status: "ok" });
    expect(returned).toEqual([]);
    expect(fs.existsSync(histFile(tmpRoot, "zr1"))).toBe(false);
  });

  it("removes a stale history file that was written before retain was set to 0", () => {
    // First, write a valid history entry with normal retention.
    store.saveScheduleYaml({ id: "zr2", every: "5m" });
    store.appendRunResult("zr2", { runAt: "t1", agentId: "a1", status: "ok" });
    expect(fs.existsSync(histFile(tmpRoot, "zr2"))).toBe(true);

    // Now update the schedule to retain=0 and fire again — stale file must be removed.
    store.saveScheduleYaml({ id: "zr2", every: "5m", history: { enabled: true, retain: 0 } });
    const returned = store.appendRunResult("zr2", { runAt: "t2", agentId: "a2", status: "ok" });
    expect(returned).toEqual([]);
    expect(fs.existsSync(histFile(tmpRoot, "zr2"))).toBe(false);
  });
});

// ── updateRunResult — empty-history early exit ────────────────────────────

describe("updateRunResult — empty history array", () => {
  it("returns null when the schedule has history enabled but no entries yet", () => {
    // History is enabled (default) but appendRunResult has never been called,
    // so the .history.json file does not exist → getRunHistory returns [].
    // The `history.length === 0` guard on line ~256 must return null.
    store.saveScheduleYaml({ id: "emp1", every: "5m" });
    const result = store.updateRunResult("emp1", "any-agent", { status: "done" });
    expect(result).toBeNull();
  });
});
