/**
 * Focused test: plans-store refuses to operate when the workspace context is
 * NOT initialized, rather than silently falling back to the global
 * `~/.zana/plans` namespace.
 *
 * Rationale (see CLAUDE.md "Workspace context — tenant isolation invariant" and
 * plans-store.ts getPlansDir): plans capture orchestrator reasoning and decision
 * logs. Falling back to the host-global `~/.zana/` dir would mix those records
 * across every workspace on the machine, leaking cross-tenant state. The store
 * must therefore throw WorkspaceNotInitializedError on the public API surface
 * whenever the singleton has not been bootstrapped.
 *
 * Every other plans-store test file initializes the workspace before exercising
 * the API, so the *refusal* branch of getPlansDir was previously unexercised.
 * This test drives it via the test-only _resetForTesting() hook.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as core from "@zana-ai/core";
import {
  createPlan,
  listPlans,
  getPlan,
  updatePlan,
  deletePlan,
} from "../../src/runs/plans-store.ts";

const wctx = (core as any).project.workspaceContext;

describe("plans-store — tenant-isolation gate (uninitialized workspace)", () => {
  beforeEach(() => {
    // Simulate "workspace not yet bootstrapped".
    wctx._resetForTesting();
  });

  afterEach(() => {
    wctx._resetForTesting();
  });

  it("is genuinely uninitialized for this test", () => {
    expect(wctx.isInitialized()).toBe(false);
  });

  it("createPlan throws WorkspaceNotInitializedError instead of writing to ~/.zana", () => {
    expect(() => createPlan({ title: "leak attempt", content: "x" })).toThrow(
      /workspace not initialized/i,
    );
  });

  it("listPlans refuses to enumerate the global fallback dir", () => {
    expect(() => listPlans()).toThrow(/workspace not initialized/i);
  });

  it("getPlan refuses to read from the global fallback dir for a real id", () => {
    expect(() => getPlan("some-plan-id")).toThrow(/workspace not initialized/i);
  });

  it("updatePlan refuses to mutate the global fallback dir", () => {
    expect(() => updatePlan("some-plan-id", { status: "done" })).toThrow(
      /workspace not initialized/i,
    );
  });

  it("deletePlan refuses to unlink from the global fallback dir for a real id", () => {
    expect(() => deletePlan("some-plan-id")).toThrow(
      /workspace not initialized/i,
    );
  });

  it("the thrown error carries the tenant-isolation error code", () => {
    let caught: any;
    try {
      createPlan({ title: "leak attempt" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
  });

  it("getPlan/deletePlan still short-circuit on falsy id WITHOUT throwing the gate", () => {
    // These guards run before any path resolution, so they must not throw even
    // when the workspace is uninitialized.
    expect(getPlan("")).toBeNull();
    expect(getPlan(null as any)).toBeNull();
    expect(deletePlan("")).toBe(false);
    expect(deletePlan(null as any)).toBe(false);
  });
});
