import { describe, it, expect, beforeAll } from "vitest";
import * as planner from "@zana-ai/intelligence/src/intelligence/goap-planner.ts";

/**
 * goap-planner — core plan-creation logic.
 *
 * Tests focus on the public API: registerAction, createPlan, getPlanStatus,
 * listPlans, cancelPlan. The module holds shared state (plans Map) so tests
 * are designed to be additive rather than relying on a clean slate — each
 * creates its own uniquely-identifiable plan.
 *
 * No real agents or network — createPlan uses the built-in action registry
 * and the real (in-process) event bus, which is a plain EventEmitter.
 */

// ─── registerAction ──────────────────────────────────────────────────────────

describe("registerAction()", () => {
  it("throws when id is missing", () => {
    expect(() =>
      planner.registerAction({ effects: { done: true }, profileId: "p1" } as any),
    ).toThrow("Action requires id, effects, and profileId");
  });

  it("throws when effects is missing", () => {
    expect(() =>
      planner.registerAction({ id: "x", profileId: "p1" } as any),
    ).toThrow("Action requires id, effects, and profileId");
  });

  it("throws when profileId is missing", () => {
    expect(() =>
      planner.registerAction({ id: "x", effects: { done: true } } as any),
    ).toThrow("Action requires id, effects, and profileId");
  });

  it("registers a valid action without throwing", () => {
    expect(() =>
      planner.registerAction({
        id: "test-action-register",
        effects: { testGoal: true },
        profileId: "tester",
      }),
    ).not.toThrow();
  });
});

// ─── createPlan ──────────────────────────────────────────────────────────────

describe("createPlan()", () => {
  it("returns planId, layers, and estimatedCost for a keyword-matched goal", () => {
    const result = planner.createPlan("implement a new feature");
    expect(result).toHaveProperty("planId");
    expect(typeof result.planId).toBe("string");
    expect(result.planId.length).toBeGreaterThan(0);
    expect(Array.isArray(result.layers)).toBe(true);
    expect(result.layers.length).toBeGreaterThan(0);
    expect(typeof result.estimatedCost).toBe("number");
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  it("returns planId, layers, and estimatedCost for a review-type goal", () => {
    const result = planner.createPlan("review the code for quality issues");
    expect(result).toHaveProperty("planId");
    expect(Array.isArray(result.layers)).toBe(true);
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  it("each layer is a non-empty array of actions", () => {
    const result = planner.createPlan("write tests for the module");
    for (const layer of result.layers) {
      expect(Array.isArray(layer)).toBe(true);
      expect(layer.length).toBeGreaterThan(0);
    }
  });

  it("accepts an explicit goalState override", () => {
    const result = planner.createPlan("custom goal", {
      goalState: { codeWritten: true },
    });
    expect(result).toHaveProperty("planId");
    expect(result.layers.length).toBeGreaterThan(0);
  });

  it("throws when no plan can satisfy an impossible goalState", () => {
    // A goal state key with no action that produces it is unsatisfiable.
    expect(() =>
      planner.createPlan("impossible goal", {
        goalState: { __no_action_produces_this__: true },
        initialState: { __no_action_produces_this__: false },
      }),
    ).toThrow("No valid plan found for goal");
  });
});

// ─── getPlanStatus ────────────────────────────────────────────────────────────

describe("getPlanStatus()", () => {
  it("returns null for an unknown planId", () => {
    expect(planner.getPlanStatus("nonexistent-plan-id")).toBeNull();
  });

  it("returns the correct shape for an existing plan", () => {
    const { planId } = planner.createPlan("analyze requirements for a spec");
    const status = planner.getPlanStatus(planId);
    expect(status).not.toBeNull();
    expect(status!.planId).toBe(planId);
    expect(status!.state).toBe("created");
    expect(typeof status!.currentLayer).toBe("number");
    expect(typeof status!.progress).toBe("number");
    expect(Array.isArray(status!.actions)).toBe(true);
  });

  it("all actions start as pending", () => {
    const { planId } = planner.createPlan("build and develop a feature");
    const status = planner.getPlanStatus(planId);
    for (const action of status!.actions) {
      expect(action.status).toBe("pending");
    }
  });
});

// ─── listPlans ────────────────────────────────────────────────────────────────

describe("listPlans()", () => {
  it("includes a newly created plan", () => {
    const { planId } = planner.createPlan("design system architecture diagram");
    const listed = planner.listPlans();
    const found = listed.find((p) => p.planId === planId);
    expect(found).toBeDefined();
    expect(found!.state).toBe("created");
    expect(typeof found!.goal).toBe("string");
    expect(typeof found!.progress).toBe("number");
    expect(typeof found!.createdAt).toBe("number");
  });
});

// ─── cancelPlan ───────────────────────────────────────────────────────────────

describe("cancelPlan()", () => {
  it("returns false for a non-existent planId", () => {
    expect(planner.cancelPlan("does-not-exist")).toBe(false);
  });

  it("cancels an existing plan and returns true", () => {
    const { planId } = planner.createPlan("fix bugs and resolve issues");
    const result = planner.cancelPlan(planId);
    expect(result).toBe(true);
    expect(planner.getPlanStatus(planId)!.state).toBe("cancelled");
  });

  it("returns false when cancelling an already-cancelled plan", () => {
    const { planId } = planner.createPlan("patch and repair issues");
    planner.cancelPlan(planId); // first cancel
    expect(planner.cancelPlan(planId)).toBe(false);
  });
});

// ─── replan ───────────────────────────────────────────────────────────────────
//
// replan() is called by executePlan() when a layer has failures, and can also
// be invoked externally to reroute an in-flight plan.  It updates plan.layers
// and plan.actions in-place.
//
// We exercise the three code paths that don't require real agent execution:
//   1. Non-existent planId              → { success: false }
//   2. Goals still unmet (fresh plan)   → { success: true, newLayers: [...] }
//   3. Actions are reset to "pending"   → visible via getPlanStatus()

describe("replan()", () => {
  it("returns { success: false } for a non-existent planId", () => {
    expect(planner.replan("__ghost_replan_plan__")).toEqual({ success: false });
  });

  it("returns { success: true } with newLayers when goals are unmet", () => {
    // A freshly created plan has currentState = all-false and goalState = desired
    // truths, so every goal key remains unmet.  replan() must find a new path.
    const { planId } = planner.createPlan("implement a feature and write tests");
    const result = planner.replan(planId) as { success: boolean; newLayers: unknown[][] };
    expect(result.success).toBe(true);
    expect(Array.isArray(result.newLayers)).toBe(true);
    expect(result.newLayers.length).toBeGreaterThan(0);
    // Each layer must itself be a non-empty array of action objects.
    for (const layer of result.newLayers) {
      expect(Array.isArray(layer)).toBe(true);
      expect(layer.length).toBeGreaterThan(0);
    }
  });

  it("actions in the replanned plan remain accessible via getPlanStatus() as pending", () => {
    const { planId } = planner.createPlan("review code and fix bugs");
    planner.replan(planId);
    const status = planner.getPlanStatus(planId);
    expect(status).not.toBeNull();
    // All actions (original + any added by replan) should still be pending
    // since no execution has occurred.
    for (const action of status!.actions) {
      expect(action.status).toBe("pending");
    }
  });

  it("plan remains listed after replan (planId is stable)", () => {
    const { planId } = planner.createPlan("develop a new feature");
    planner.replan(planId);
    const listed = planner.listPlans();
    expect(listed.some((p) => p.planId === planId)).toBe(true);
  });
});
