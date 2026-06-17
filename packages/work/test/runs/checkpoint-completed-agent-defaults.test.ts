// Focused tests for the field-normalization defaults applied by
// addCompletedAgent() in packages/work/src/runs/checkpoint/store.ts.
//
// checkpoint-agent-mutations.test.ts already covers the pending→completed
// move and the not-found null path. NOT covered there: the per-field
// defaulting logic on the appended completedAgents record —
//   prompt:   agentData.prompt   || ""
//   result:   agentData.result   || ""
//   exitCode: agentData.exitCode ?? 0   (?? so an explicit 0 / nonzero is kept)
//   completedAt: Date.now()             (always stamped)
//
// Deterministic: all fs I/O lands in a tmp dir torn down in afterEach; no
// real network or clock dependency (we only assert completedAt is a number).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";

describe("checkpoint store: addCompletedAgent field defaults", () => {
  let tmpRoot: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-completed-defaults-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("defaults prompt/result to empty string and exitCode to 0, and stamps completedAt", () => {
    store.save({ id: "cp-defaults", teamId: "t1", status: "running" });

    // Only the required identity fields — prompt, result, exitCode omitted.
    store.addCompletedAgent("cp-defaults", {
      agentId: "a1",
      profileId: "p1",
      profileName: "researcher",
    });

    const cp = store.load("cp-defaults");
    expect(cp.completedAgents).toHaveLength(1);
    const rec = cp.completedAgents[0];
    expect(rec.agentId).toBe("a1");
    expect(rec.profileId).toBe("p1");
    expect(rec.profileName).toBe("researcher");
    expect(rec.prompt).toBe("");
    expect(rec.result).toBe("");
    expect(rec.exitCode).toBe(0);
    expect(typeof rec.completedAt).toBe("number");
  });

  it("preserves an explicit nonzero exitCode (?? keeps the supplied value)", () => {
    store.save({ id: "cp-exit", teamId: "t2", status: "running" });

    store.addCompletedAgent("cp-exit", {
      agentId: "a2",
      profileId: "p2",
      profileName: "coder",
      prompt: "build it",
      result: "failed",
      exitCode: 2,
    });

    const rec = store.load("cp-exit").completedAgents[0];
    expect(rec.exitCode).toBe(2);
    expect(rec.prompt).toBe("build it");
    expect(rec.result).toBe("failed");
  });
});
