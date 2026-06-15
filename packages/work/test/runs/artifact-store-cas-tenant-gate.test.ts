// Tenant-isolation gate for storeContentAddressed (FU-T2d).
//
// storeContentAddressed MUST refuse to write a content-addressed blob when the
// workspace context is not initialized. Otherwise the blob would land in the
// shared global fallback (~/.zana/artifacts/blobs/), letting workspace B probe
// workspace A's audit substrate by guessing hashes.
//
// Existing CAS tests always init() the workspace, so the *refusal* branch
// (artifact-store.ts: `if (!ctx.isInitialized()) throw WorkspaceNotInitializedError`)
// is never exercised. These tests cover it, plus the documented invariant that
// READS stay open while the workspace is uninitialized.
//
// artifact-store reaches the workspace context via require("@zana-ai/core")
// (the dist instance), so we reset/inspect that instance specifically.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import * as core from "@zana-ai/core";
import * as artifactStore from "@zana-ai/work/src/runs/artifact-store.ts";

const ctx: any = (core as any).project.workspaceContext;

describe("storeContentAddressed — tenant-isolation gate (uninitialized workspace)", () => {
  beforeEach(() => {
    // Simulate "workspace not yet bootstrapped".
    ctx._resetForTesting();
  });

  afterEach(() => {
    ctx._resetForTesting();
  });

  it("throws WorkspaceNotInitializedError instead of writing to the global fallback", () => {
    expect(ctx.isInitialized()).toBe(false);

    let thrown: any;
    try {
      artifactStore.storeContentAddressed("deliberation rationale that must stay tenant-scoped");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(thrown.name).toBe("WorkspaceNotInitializedError");
    expect(thrown.code).toBe("WORKSPACE_NOT_INITIALIZED");
    expect(thrown.operation).toBe("store");
    // The error advertises the blob path it refused to write.
    expect(String(thrown.path)).toMatch(/artifacts[\\/]blobs/);
  });

  it("refuses Buffer payloads too, and gates BEFORE the toBuffer type check", () => {
    // Even an invalid bytes type must surface the isolation error first —
    // the gate runs before toBuffer(), so a non-Buffer/non-string does NOT
    // produce a TypeError while the workspace is uninitialized.
    expect(() =>
      artifactStore.storeContentAddressed(Buffer.from("blob", "utf8")),
    ).toThrow(/workspace not initialized/i);

    let thrown: any;
    try {
      artifactStore.storeContentAddressed(42 as any);
    } catch (err) {
      thrown = err;
    }
    expect(thrown.name).toBe("WorkspaceNotInitializedError");
  });

  it("keeps READS open while uninitialized (list/has/read return safely, never throw)", () => {
    // The isolation gate guards WRITES only — prior global-scope state must
    // stay inspectable. None of these may throw. list() may legitimately
    // surface blobs from the global fallback (~/.zana/artifacts/blobs), so we
    // only assert it returns an array of canonical entries rather than [].
    const list = artifactStore.listContentAddressed();
    expect(Array.isArray(list)).toBe(true);
    for (const entry of list) {
      expect(entry.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }

    // A hash that cannot exist must read back safely without throwing.
    const missing = "sha256:" + "a".repeat(64);
    expect(artifactStore.hasContentAddressed(missing)).toBe(false);
    expect(artifactStore.readContentAddressed(missing)).toBeNull();
  });
});
