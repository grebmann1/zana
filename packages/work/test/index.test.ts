// Tests for packages/work/src/index.ts
//
// The entry-point barrel is a CommonJS module that stitches together all
// sub-domains and re-exports WorkspaceNotInitializedError from @zana-ai/core
// behind a lazy getter so callers can instanceof-check it without taking a
// direct @zana-ai/core dependency.
//
// Coverage:
//   - All expected top-level namespaces are present and non-null
//   - Each namespace exposes its core symbols
//   - WorkspaceNotInitializedError is the canonical class (not undefined, not a copy)
//   - The getter is stable: repeated access returns the identical reference
//   - An instance of the class passes instanceof on the re-exported getter
//
// Note: src/index.ts is a CJS barrel whose internal `require("./sub-module")` calls
// bypass Vite's SSR resolveId plugin (which only intercepts ESM imports, not runtime
// CJS requires). The compiled dist/ artefact is used here — it is the real
// production surface and tests the exact contract callers depend on.

import { describe, it, expect } from "vitest";
import * as path from "node:path";

// Resolve relative to this file so the path works regardless of CWD.
const distIndex = path.resolve(__dirname, "../dist/src/index.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const workIndex = require(distIndex) as any;

describe("@zana-ai/work entry-point barrel", () => {
  describe("namespace shape", () => {
    it("exports a tickets namespace with expected keys", () => {
      expect(workIndex).toHaveProperty("tickets");
      const { tickets } = workIndex as any;
      expect(tickets).toHaveProperty("service");
      expect(tickets).toHaveProperty("store");
      expect(tickets).toHaveProperty("db");
      expect(tickets).toHaveProperty("migration");
      expect(tickets).toHaveProperty("watcher");
      expect(tickets).toHaveProperty("sweeper");
    });

    it("exports a scheduling namespace with expected keys", () => {
      expect(workIndex).toHaveProperty("scheduling");
      const { scheduling } = workIndex as any;
      expect(scheduling).toHaveProperty("service");
      expect(scheduling).toHaveProperty("store");
      expect(scheduling).toHaveProperty("workflowEngine");
      expect(scheduling).toHaveProperty("schema");
    });

    it("exports a teams namespace with expected keys", () => {
      expect(workIndex).toHaveProperty("teams");
      const { teams } = workIndex as any;
      expect(teams).toHaveProperty("manager");
      expect(teams).toHaveProperty("store");
    });

    it("exports a runs namespace with expected keys", () => {
      expect(workIndex).toHaveProperty("runs");
      const { runs } = workIndex as any;
      expect(runs).toHaveProperty("store");
      expect(runs).toHaveProperty("tracker");
      expect(runs).toHaveProperty("artifacts");
      expect(runs).toHaveProperty("plans");
      expect(runs).toHaveProperty("checkpoint");
      expect(runs.checkpoint).toHaveProperty("store");
      expect(runs.checkpoint).toHaveProperty("resume");
    });

    it("exports a deliberation namespace", () => {
      expect(workIndex).toHaveProperty("deliberation");
      expect((workIndex as any).deliberation).toBeTruthy();
    });
  });

  describe("WorkspaceNotInitializedError lazy getter", () => {
    it("is accessible on the module", () => {
      expect((workIndex as any).WorkspaceNotInitializedError).toBeDefined();
    });

    it("is a constructor (function)", () => {
      const { WorkspaceNotInitializedError } = workIndex as any;
      expect(typeof WorkspaceNotInitializedError).toBe("function");
    });

    it("returns the same reference on repeated access (stable getter)", () => {
      const first = (workIndex as any).WorkspaceNotInitializedError;
      const second = (workIndex as any).WorkspaceNotInitializedError;
      expect(first).toBe(second);
    });

    it("instances pass instanceof on the re-exported class", () => {
      const { WorkspaceNotInitializedError } = workIndex as any;
      const err = new WorkspaceNotInitializedError();
      expect(err).toBeInstanceOf(WorkspaceNotInitializedError);
    });

    it("is the same class as the one from @zana-ai/core directly", () => {
      const { WorkspaceNotInitializedError } = workIndex;
      // Resolve @zana-ai/core's dist entry to compare the canonical export.
      const coreDist = path.resolve(__dirname, "../../core/dist/src/project/workspace-context.js");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const coreWc = require(coreDist) as any;
      expect(WorkspaceNotInitializedError).toBe(coreWc.WorkspaceNotInitializedError);
    });

    it("produced errors are instanceof Error", () => {
      const { WorkspaceNotInitializedError } = workIndex as any;
      expect(new WorkspaceNotInitializedError()).toBeInstanceOf(Error);
    });
  });
});
