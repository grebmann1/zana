// Focused tests for two untested paths in plans-store:
//   1. listPlans({ createdBy }) filter
//   2. ID sanitization (path-traversal protection) in getPlan / updatePlan / deletePlan
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import {
  createPlan,
  listPlans,
  getPlan,
  updatePlan,
  deletePlan,
} from "@zana-ai/work/src/runs/plans-store.ts";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-plans-filters-${Date.now()}-${process.pid}`
);

describe("plans-store — listPlans createdBy filter", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  it("returns only plans whose createdBy matches the filter", () => {
    createPlan({ title: "Alice plan", content: "", createdBy: "alice", linkedTickets: [], tags: [] });
    createPlan({ title: "Bob plan",   content: "", createdBy: "bob",   linkedTickets: [], tags: [] });
    createPlan({ title: "Alice 2",    content: "", createdBy: "alice", linkedTickets: [], tags: [] });

    const alicePlans = listPlans({ createdBy: "alice" } as any);
    expect(alicePlans.length).toBe(2);
    expect(alicePlans.every((p: any) => p.createdBy === "alice")).toBe(true);
  });

  it("returns an empty array when no plan matches the createdBy filter", () => {
    createPlan({ title: "Only Alice", content: "", createdBy: "alice", linkedTickets: [], tags: [] });
    expect(listPlans({ createdBy: "nobody" } as any)).toEqual([]);
  });

  it("combines createdBy and status filters correctly", () => {
    const p = createPlan({ title: "Approved by Alice", content: "", createdBy: "alice", linkedTickets: [], tags: [] });
    updatePlan(p.id, { status: "approved" });
    createPlan({ title: "Draft by Alice", content: "", createdBy: "alice", linkedTickets: [], tags: [] });
    createPlan({ title: "Approved by Bob", content: "", createdBy: "bob", linkedTickets: [], tags: [] });

    const results = listPlans({ createdBy: "alice", status: "approved" } as any);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Approved by Alice");
  });
});

describe("plans-store — ID sanitization (path-traversal protection)", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  it("getPlan strips path-traversal characters and returns null for the sanitized non-existent id", () => {
    // "../../etc/passwd" strips to "etcpasswd" — no such file, should return null
    expect(getPlan("../../etc/passwd")).toBeNull();
  });

  it("updatePlan strips path-traversal characters and returns null for the sanitized non-existent id", () => {
    expect(updatePlan("../../etc/passwd", { title: "evil" })).toBeNull();
  });

  it("deletePlan strips path-traversal characters and returns false for the sanitized non-existent id", () => {
    expect(deletePlan("../../etc/passwd")).toBe(false);
  });

  it("getPlan resolves correctly when UUID-style ids contain only allowed characters", () => {
    const plan = createPlan({ title: "Valid", content: "body", createdBy: "u", linkedTickets: [], tags: [] });
    // UUID chars are all alphanumeric + hyphens — sanitization is a no-op
    const fetched = getPlan(plan.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Valid");
  });
});
