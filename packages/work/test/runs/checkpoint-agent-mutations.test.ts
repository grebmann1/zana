// Focused tests for the addCompletedAgent / addPendingAgent mutations in
// packages/work/src/runs/checkpoint/store.ts.
//
// Specific invariants not covered by the existing checkpoint-atomic,
// checkpoint-ttl, or checkpoint/store test suites:
//   1. addCompletedAgent removes the agent from pendingAgents (the filter line).
//   2. addCompletedAgent returns null when the checkpoint does not exist.
//   3. addPendingAgent returns null when the checkpoint does not exist.
//   4. addPendingAgent initialises pendingAgents when the array is absent.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

describe("checkpoint store: addCompletedAgent / addPendingAgent mutations", () => {
  let tmpRoot: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-agent-mut-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── addCompletedAgent ────────────────────────────────────────────────────────

  it("addCompletedAgent removes the agent from pendingAgents", () => {
    store.save({ id: "rmw-pending", teamId: "t1", status: "running" });
    store.addPendingAgent("rmw-pending", { agentId: "a1", profileId: "p1", prompt: "step 1" });
    store.addPendingAgent("rmw-pending", { agentId: "a2", profileId: "p2", prompt: "step 2" });

    const before = store.load("rmw-pending");
    expect(before.pendingAgents).toHaveLength(2);

    store.addCompletedAgent("rmw-pending", {
      agentId: "a1",
      profileId: "p1",
      profileName: "researcher",
      result: "done",
    });

    const after = store.load("rmw-pending");
    // a1 must have moved to completedAgents …
    expect(after.completedAgents).toHaveLength(1);
    expect(after.completedAgents[0].agentId).toBe("a1");
    // … and been removed from pendingAgents
    expect(after.pendingAgents).toHaveLength(1);
    expect(after.pendingAgents[0].agentId).toBe("a2");
  });

  it("addCompletedAgent returns null when the checkpoint does not exist", () => {
    const result = store.addCompletedAgent("ghost-cp", {
      agentId: "a1",
      profileId: "p1",
      profileName: "coder",
      result: "ok",
    });
    expect(result).toBeNull();
  });

  // ── addPendingAgent ──────────────────────────────────────────────────────────

  it("addPendingAgent initialises pendingAgents when the field is absent", () => {
    store.save({ id: "no-pending", teamId: "t2", status: "running" });
    const before = store.load("no-pending");
    expect(before.pendingAgents).toBeUndefined();

    store.addPendingAgent("no-pending", { profileId: "p1", prompt: "work" });

    const after = store.load("no-pending");
    expect(Array.isArray(after.pendingAgents)).toBe(true);
    expect(after.pendingAgents).toHaveLength(1);
  });

  it("addPendingAgent returns null when the checkpoint does not exist", () => {
    const result = store.addPendingAgent("ghost-cp-2", {
      profileId: "p1",
      prompt: "do something",
    });
    expect(result).toBeNull();
  });
});
