// task-router — edge cases not covered by task-router-route.test.ts or
// task-router-lens.test.ts.  Focus: resolveVoters() invalid-spec error paths
// and init() idempotency.
import { describe, it, expect, beforeEach } from "vitest";
import * as taskRouter from "@zana-ai/intelligence/src/intelligence/task-router.ts";
import * as core from "@zana-ai/core";

beforeEach(() => {
  taskRouter.reset();
});

// ─── resolveVoters() — invalid spec shapes ───────────────────────────────────

describe("resolveVoters() — invalid spec error paths", () => {
  it("throws on an object with neither profileId nor lens", () => {
    expect(() =>
      taskRouter.resolveVoters([{ role: "architect" } as any]),
    ).toThrow(/invalid voter spec/);
  });

  it("throws on an object with empty profileId string", () => {
    // An empty string is falsy, so the branch falls through to the error throw.
    expect(() =>
      taskRouter.resolveVoters([{ profileId: "" }]),
    ).toThrow(/invalid voter spec/);
  });

  it("throws on a numeric entry in the array", () => {
    expect(() =>
      taskRouter.resolveVoters([42 as any]),
    ).toThrow(/invalid voter spec/);
  });

  it("throws on a null entry in the array", () => {
    expect(() =>
      taskRouter.resolveVoters([null as any]),
    ).toThrow(/invalid voter spec/);
  });

  it("throws on a boolean entry in the array", () => {
    expect(() =>
      taskRouter.resolveVoters([true as any]),
    ).toThrow(/invalid voter spec/);
  });
});

// ─── init() idempotency ──────────────────────────────────────────────────────

describe("init()", () => {
  it("can be called multiple times without error or side-effects", () => {
    expect(() => {
      taskRouter.init();
      taskRouter.init();
      taskRouter.init();
    }).not.toThrow();
    // Outcomes must still be empty (reset() was called in beforeEach, init()
    // must not inject phantom entries).
    const stats = taskRouter.getStats();
    expect(stats.totalOutcomes).toBe(0);
  });
});

// ─── Tenant isolation gate ───────────────────────────────────────────────────

describe("recordOutcome() — tenant isolation gate", () => {
  it("throws WorkspaceNotInitializedError when workspace not initialized", () => {
    const wcDist: any = (core as any).project.workspaceContext;
    const ErrCtor = wcDist.WorkspaceNotInitializedError;
    try { wcDist._resetForTesting?.(); } catch {}
    expect(wcDist.isInitialized()).toBe(false);

    let caught: any = null;
    try {
      taskRouter.recordOutcome({
        ticketId: "t-iso",
        profileId: "architect",
        success: true,
        labels: [],
        keywords: [],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ErrCtor);
    expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
  });
});
