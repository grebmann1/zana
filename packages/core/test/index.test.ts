// Unit tests for packages/core/src/index.ts
//
// Focus: the documented invariants in the composition layer —
//   • WorkspaceNotInitializedError top-level alias has the same class identity
//     as the one exposed through project.workspaceContext.
//   • The `intelligence` getter renames goapPlanner → goap (and does not
//     surface the old name).
//   • The `scheduling` getter renames workflowEngine → workflow.
//   • The `runs` getter flattens `r.checkpoint.store` to `checkpoint`
//     (drops the nested `resume` key).

import { describe, it, expect } from "vitest";

// Use the package root so vitest's `noExternal` SSR transforms resolve it to
// packages/core/src/index.ts — identical to how production consumers import.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require("@zana-ai/core") as any;

describe("packages/core/src/index.ts — composition invariants", () => {
  describe("WorkspaceNotInitializedError top-level alias", () => {
    it("is defined at the top level", () => {
      expect(core.WorkspaceNotInitializedError).toBeDefined();
    });

    it("has the same class identity as project.workspaceContext.WorkspaceNotInitializedError", () => {
      // Documented invariant in index.ts comments:
      //   "Same class identity as
      //    require('@zana-ai/core').project.workspaceContext.WorkspaceNotInitializedError"
      expect(core.WorkspaceNotInitializedError).toBe(
        core.project.workspaceContext.WorkspaceNotInitializedError,
      );
    });

    it("can be used to construct and instanceof-check an error", () => {
      const err = new core.WorkspaceNotInitializedError("test");
      expect(err).toBeInstanceOf(core.WorkspaceNotInitializedError);
      expect(err).toBeInstanceOf(core.project.workspaceContext.WorkspaceNotInitializedError);
    });
  });

  describe("intelligence getter — reshape", () => {
    it("exposes goap (not goapPlanner)", () => {
      const intel = core.intelligence;
      expect(intel.goap).toBeDefined();
      // The raw package name is goapPlanner; the index renames it to goap.
      expect(intel.goapPlanner).toBeUndefined();
    });

    it("exposes taskRouter, vectorMemory, and backgroundWorkers unchanged", () => {
      const intel = core.intelligence;
      expect(intel.taskRouter).toBeDefined();
      expect(intel.vectorMemory).toBeDefined();
      expect(intel.backgroundWorkers).toBeDefined();
    });

    it("intelligence.goap is the same object as the goapPlanner from @zana-ai/intelligence", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rawIntel = require("@zana-ai/intelligence") as any;
      expect(core.intelligence.goap).toBe(rawIntel.goapPlanner);
    });
  });

  describe("scheduling getter — reshape", () => {
    it("exposes workflow (not workflowEngine)", () => {
      const sched = core.scheduling;
      expect(sched.workflow).toBeDefined();
      // @zana-ai/work exposes it as workflowEngine; index renames it to workflow.
      expect(sched.workflowEngine).toBeUndefined();
    });

    it("exposes service and store unchanged", () => {
      const sched = core.scheduling;
      expect(sched.service).toBeDefined();
      expect(sched.store).toBeDefined();
    });
  });

  describe("runs getter — reshape (checkpoint flattening)", () => {
    it("exposes checkpoint as the store directly (not the {store, resume} object)", () => {
      const runs = core.runs;
      // @zana-ai/work exposes runs.checkpoint.store; index flattens to checkpoint.
      // The store module has a known function (e.g. save/load), not a nested {store, resume} shape.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rawWork = require("@zana-ai/work") as any;
      expect(runs.checkpoint).toBe(rawWork.runs.checkpoint.store);
    });

    it("does not expose checkpoint.store (would mean double-nesting)", () => {
      // If flattening were broken, runs.checkpoint would be the {store, resume} object.
      // Guard against regression by verifying that runs.checkpoint !== the intermediate object.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rawWork = require("@zana-ai/work") as any;
      expect(core.runs.checkpoint).not.toBe(rawWork.runs.checkpoint);
    });

    it("exposes store, tracker, artifacts, and plans unchanged", () => {
      const runs = core.runs;
      expect(runs.store).toBeDefined();
      expect(runs.tracker).toBeDefined();
      expect(runs.artifacts).toBeDefined();
      expect(runs.plans).toBeDefined();
    });
  });
});
