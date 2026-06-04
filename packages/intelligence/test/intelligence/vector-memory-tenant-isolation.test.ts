// Tenant-isolation gate regression test for vector-memory.flushToDisk().
//
// Prior to the broaden gate, vector-memory always wrote to ~/.zana/memory/
// regardless of workspace context — auto-indexed agent completions across
// tenants would silently merge into a shared store. flushToDisk now refuses
// the fallback when no workspace is initialized.
//
// We exercise flushToDisk indirectly via store() + a direct flush call.
// This file does NOT mock @zana-ai/core (the existing vector-memory.test.ts
// does, which is why this is a separate file).

import { describe, it, expect } from "vitest";
import * as core from "@zana-ai/core";
import * as vm from "@zana-ai/intelligence/src/intelligence/vector-memory.ts";

describe("vector-memory tenant-isolation gate", () => {
  it("flushToDisk throws WorkspaceNotInitializedError when workspace not initialized", () => {
    const wcDist: any = (core as any).project.workspaceContext;
    const ErrCtor = wcDist.WorkspaceNotInitializedError;
    try { wcDist._resetForTesting?.(); } catch {}
    expect(wcDist.isInitialized()).toBe(false);

    // store() registers an entry and schedules a debounced save. We invoke
    // flushToDisk directly via the exported saveSync if available, or by
    // calling shutdown() which forces a flush. shutdown() in vector-memory
    // ends up calling flushToDisk.
    vm.store({
      content: "tenant-iso vector-memory gate test entry",
      tier: "episodic",
    });

    let caught: any = null;
    try {
      // shutdown() forces a flush; under the gate, that flush refuses.
      vm.shutdown();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ErrCtor);
    expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
  });
});
