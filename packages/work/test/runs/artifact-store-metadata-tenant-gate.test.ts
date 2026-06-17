// Tenant-isolation gate for artifact METADATA writes (createArtifact /
// updateArtifact / deleteArtifact). Companion to the CAS-blob gate test.
//
// The CAS blob path (storeContentAddressed) was gated, but the JSON metadata
// write paths 80 lines away were NOT — they called ensureDir() then
// fs.writeFileSync() with no isInitialized() check, so an uninitialized
// workspace silently wrote artifact records into the shared
// ~/.zana/artifacts/, mixing one workspace's planning docs into another's
// (ADR 0002 violation). Found by the 2026-06-17 architect review. These tests
// pin the refusal; READS stay open.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import * as core from "@zana-ai/core";
import * as artifactStore from "@zana-ai/work/src/runs/artifact-store.ts";

const ctx: any = (core as any).project.workspaceContext;

describe("artifact metadata writes — tenant-isolation gate (uninitialized workspace)", () => {
  beforeEach(() => { ctx._resetForTesting(); });
  afterEach(() => { ctx._resetForTesting(); });

  it("createArtifact refuses instead of writing to the global fallback", () => {
    expect(ctx.isInitialized()).toBe(false);
    let thrown: any;
    try {
      artifactStore.createArtifact({ title: "tenant-scoped spec", type: "design-doc", content: "secret" });
    } catch (err) { thrown = err; }
    expect(thrown).toBeDefined();
    expect(thrown.name).toBe("WorkspaceNotInitializedError");
    expect(thrown.operation).toBe("createArtifact");
    expect(String(thrown.path)).toMatch(/artifacts/);
  });

  it("updateArtifact refuses while uninitialized", () => {
    expect(() => artifactStore.updateArtifact("some-id", { title: "x" })).toThrow(/workspace not initialized/i);
  });

  it("deleteArtifact refuses while uninitialized", () => {
    expect(() => artifactStore.deleteArtifact("some-id")).toThrow(/workspace not initialized/i);
  });

  it("keeps READS open while uninitialized (list/get never throw)", () => {
    expect(Array.isArray(artifactStore.listArtifacts())).toBe(true);
    expect(artifactStore.getArtifact("nonexistent")).toBeNull();
  });
});
