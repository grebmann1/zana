// Focused tests for the field-normalization defaults applied by
// addPendingAgent() in packages/work/src/runs/checkpoint/store.ts.
//
// checkpoint-agent-mutations.test.ts already covers pendingAgents array
// initialisation and the not-found null path; checkpoint-completed-agent-
// defaults.test.ts covers the completed-record defaulting. NOT covered
// anywhere: the per-field defaulting on the appended pendingAgents record —
//   agentId:        agentData.agentId        || null
//   parentAgentId:  agentData.parentAgentId  || null
//   dependencies:   agentData.dependencies   || []
// and the symmetric case where each value is supplied and must be preserved.
//
// Deterministic: all fs I/O lands in a tmp dir torn down in afterEach; no
// real network or clock dependency.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

describe("checkpoint store: addPendingAgent field defaults", () => {
  let tmpRoot: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-pending-defaults-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("defaults agentId/parentAgentId to null and dependencies to [] when omitted", () => {
    store.save({ id: "cp-pending-defaults", teamId: "t1", status: "running" });

    // Only the required fields — agentId, parentAgentId, dependencies omitted.
    store.addPendingAgent("cp-pending-defaults", {
      profileId: "p1",
      prompt: "do work",
    });

    const cp = store.load("cp-pending-defaults");
    expect(cp.pendingAgents).toHaveLength(1);
    const rec = cp.pendingAgents[0];
    expect(rec.profileId).toBe("p1");
    expect(rec.prompt).toBe("do work");
    expect(rec.agentId).toBeNull();
    expect(rec.parentAgentId).toBeNull();
    expect(rec.dependencies).toEqual([]);
  });

  it("preserves supplied agentId, parentAgentId, and dependencies", () => {
    store.save({ id: "cp-pending-supplied", teamId: "t2", status: "running" });

    store.addPendingAgent("cp-pending-supplied", {
      agentId: "a2",
      profileId: "p2",
      prompt: "build it",
      parentAgentId: "parent-1",
      dependencies: ["a1", "a0"],
    });

    const rec = store.load("cp-pending-supplied").pendingAgents[0];
    expect(rec.agentId).toBe("a2");
    expect(rec.parentAgentId).toBe("parent-1");
    expect(rec.dependencies).toEqual(["a1", "a0"]);
  });
});
