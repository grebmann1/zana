import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as taskRouter from "@zana-ai/intelligence/src/intelligence/task-router.ts";
import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

/**
 * route(), recordOutcome(), getStats(), reset() — core routing logic.
 *
 * The module uses lazy-loaded core (profileStore + eventBus) via Proxy, so
 * real registered profiles are available. We reset() before each test to
 * ensure a clean outcomes list.
 *
 * recordOutcome() persists to disk; the tenant-isolation gate now refuses
 * to fall back to ~/.zana when no workspace is initialized, so we bootstrap
 * a temp workspace for the entire suite.
 */

let tmpWorkspace: string;
beforeAll(() => {
  tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "zana-task-router-route-"));
  fs.mkdirSync(path.join(tmpWorkspace, ".zana"), { recursive: true });
  workspaceContext.init(tmpWorkspace);
  try { (core as any).project.workspaceContext.init(tmpWorkspace); } catch {}
});

afterAll(() => {
  try { fs.rmSync(tmpWorkspace, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  taskRouter.reset();
});

// ─── route() ────────────────────────────────────────────────────────────────

describe("route()", () => {
  it("returns an array of { profileId, score, reason } entries", () => {
    const results = taskRouter.route({ id: "t1", title: "Fix security vulnerability" });
    expect(Array.isArray(results)).toBe(true);
    if (results.length > 0) {
      const first = results[0];
      expect(first).toHaveProperty("profileId");
      expect(first).toHaveProperty("score");
      expect(first).toHaveProperty("reason");
    }
  });

  it("returns results sorted by score descending", () => {
    const results = taskRouter.route({ id: "t2", title: "Analyze performance bottleneck" });
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
    }
  });

  it("scores must all be >= 0 and <= 1", () => {
    const results = taskRouter.route({ id: "t3", title: "Research database architecture design" });
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("handles empty title and description gracefully", () => {
    expect(() => taskRouter.route({ id: "t4" })).not.toThrow();
    const results = taskRouter.route({ id: "t4" });
    expect(Array.isArray(results)).toBe(true);
  });

  it("biases toward matching profile when history exists", () => {
    // Record two successes for architect on architecture tasks
    taskRouter.recordOutcome({
      ticketId: "h1",
      profileId: "architect",
      success: true,
      labels: ["architecture"],
      keywords: ["design", "architecture", "system"],
    });
    taskRouter.recordOutcome({
      ticketId: "h2",
      profileId: "architect",
      success: true,
      labels: ["architecture"],
      keywords: ["design", "architecture", "system"],
    });

    const results = taskRouter.route({
      id: "t5",
      title: "Design a new system architecture",
      labels: ["architecture"],
    });
    const architectResult = results.find((r) => r.profileId === "architect");
    expect(architectResult).toBeDefined();
    // architect should appear high in rankings when it has a strong match history
    const architectIndex = results.indexOf(architectResult!);
    expect(architectIndex).toBeLessThan(3);
  });

  it("does not include profiles with score 0", () => {
    // With no history and stopword-only title, capability matching returns 0 for all
    const results = taskRouter.route({ id: "t6", title: "a an the is" });
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });
});

// ─── recordOutcome() ────────────────────────────────────────────────────────

describe("recordOutcome()", () => {
  it("persists an outcome so getStats() sees it", () => {
    taskRouter.recordOutcome({
      ticketId: "out-1",
      profileId: "researcher",
      success: true,
      duration: 5000,
      labels: ["research"],
      keywords: ["data", "analysis"],
    });
    const stats = taskRouter.getStats();
    expect(stats.totalOutcomes).toBe(1);
    expect(stats.profileStats["researcher"]).toBeDefined();
    expect(stats.profileStats["researcher"].attempts).toBe(1);
    expect(stats.profileStats["researcher"].successes).toBe(1);
  });

  it("records a failure outcome correctly", () => {
    taskRouter.recordOutcome({
      ticketId: "out-2",
      profileId: "researcher",
      success: false,
      labels: [],
      keywords: [],
    });
    const stats = taskRouter.getStats();
    expect(stats.profileStats["researcher"].successes).toBe(0);
    expect(stats.profileStats["researcher"].attempts).toBe(1);
  });

  it("accumulates multiple outcomes for the same profile", () => {
    taskRouter.recordOutcome({ ticketId: "a", profileId: "architect", success: true, labels: [], keywords: [] });
    taskRouter.recordOutcome({ ticketId: "b", profileId: "architect", success: false, labels: [], keywords: [] });
    taskRouter.recordOutcome({ ticketId: "c", profileId: "architect", success: true, labels: [], keywords: [] });
    const stats = taskRouter.getStats();
    expect(stats.totalOutcomes).toBe(3);
    expect(stats.profileStats["architect"].attempts).toBe(3);
    expect(stats.profileStats["architect"].successes).toBe(2);
  });
});

// ─── getStats() ─────────────────────────────────────────────────────────────

describe("getStats()", () => {
  it("returns zero counts when no outcomes recorded", () => {
    const stats = taskRouter.getStats();
    expect(stats.totalOutcomes).toBe(0);
    expect(stats.profileStats).toEqual({});
  });

  it("computes avgDuration correctly", () => {
    taskRouter.recordOutcome({ ticketId: "d1", profileId: "coder", success: true, duration: 1000, labels: [], keywords: [] });
    taskRouter.recordOutcome({ ticketId: "d2", profileId: "coder", success: true, duration: 3000, labels: [], keywords: [] });
    const stats = taskRouter.getStats();
    expect(stats.profileStats["coder"].avgDuration).toBe(2000);
  });

  it("handles outcomes with no duration (null) without NaN", () => {
    taskRouter.recordOutcome({ ticketId: "d3", profileId: "tester", success: true, labels: [], keywords: [] });
    const stats = taskRouter.getStats();
    const avg = stats.profileStats["tester"].avgDuration;
    expect(Number.isNaN(avg)).toBe(false);
    expect(avg).toBe(0);
  });
});

// ─── reset() ────────────────────────────────────────────────────────────────

describe("reset()", () => {
  it("clears all recorded outcomes", () => {
    taskRouter.recordOutcome({ ticketId: "r1", profileId: "architect", success: true, labels: [], keywords: [] });
    taskRouter.reset();
    const stats = taskRouter.getStats();
    expect(stats.totalOutcomes).toBe(0);
    expect(stats.profileStats).toEqual({});
  });

  it("route() after reset has no history and falls back to capability matching", () => {
    taskRouter.recordOutcome({ ticketId: "r2", profileId: "architect", success: true, labels: ["arch"], keywords: ["arch"] });
    taskRouter.reset();
    // After reset, no outcomes exist; route() should still run without error
    expect(() => taskRouter.route({ id: "t-reset", title: "design architecture" })).not.toThrow();
  });
});
