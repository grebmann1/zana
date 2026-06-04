// FU-T2e — event-bus tenant isolation gate.
//
// REGRESSION: prior to this fix, packages/core/src/events/store.ts snapshotted
// EVENTS_DIR at module load time:
//
//     const EVENTS_DIR = (configMod as any).EVENTS_DIR;
//
// Because the events/store module is required from many entry points, this
// snapshot frequently froze BEFORE workspaceContext.init() ran — pinning every
// subsequent appendEvent() to the global ~/.zana/events/ directory across
// every workspace on the same host. Hashes alone are stored, but voter
// modelIds, profileIds, tally distributions, and deliberation cadence in those
// records are sufficient to correlate activity between tenants. This file
// covers the fix: events/store now lazy-resolves EVENTS_DIR per call via the
// workspace-aware getter on the @zana-ai/core config module.
//
// CRITICAL: at least one test below imports events/store BEFORE
// workspaceContext.init() to prove the snapshot bug is actually gone.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContextTs from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

// IMPORTANT: this top-level import happens at module load time, BEFORE any
// beforeEach() runs. Under the old snapshot bug, it would have captured
// the global EVENTS_DIR (~/.zana/events) into a const inside store.ts.
// With the fix, EVENTS_DIR is re-resolved on every call, so this early
// import does NOT freeze the path.
import * as eventStore from "@zana-ai/core/src/events/store.ts";

const wcDist: any = (core as any).project.workspaceContext;

function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

function bothInit(root: string) {
  workspaceContextTs.init(root);
  wcDist.init(root);
}

function makeDeliberationEvent(type: string, deliberationId: string) {
  return {
    id: `evt-${deliberationId}-${type}`,
    type,
    source: "test",
    timestamp: Date.now(),
    payload: { deliberationId, voterModelIds: ["m1", "m2"] },
    tags: ["governance", "test"],
  };
}

describe("event-bus tenant isolation (FU-T2e)", () => {
  let tmpA: string;
  let tmpB: string;
  let originalHome: string | undefined;
  let homeShim: string;

  beforeEach(() => {
    resetWorkspace();
    tmpA = makeTmp("zana-evt-iso-A-");
    tmpB = makeTmp("zana-evt-iso-B-");

    // Pre-create .zana/ inside each temp workspace so resolveProjectDir()
    // stops here rather than walking up to any ambient /tmp/.zana that may
    // exist on the host machine, which would silently mix tenant state.
    fs.mkdirSync(path.join(tmpA, ".zana"), { recursive: true });
    fs.mkdirSync(path.join(tmpB, ".zana"), { recursive: true });

    // Shim HOME so the global-fallback ZANA_DIR (~/.zana) lands in a temp
    // directory for this test rather than the user's real home. This lets
    // assertion #4 ("nothing in global") be enforced without polluting the
    // dev's actual ~/.zana/events.
    homeShim = makeTmp("zana-evt-iso-HOME-");
    originalHome = process.env.HOME;
    process.env.HOME = homeShim;
  });

  afterEach(() => {
    resetWorkspace();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const t of [tmpA, tmpB, homeShim]) {
      try { fs.rmSync(t, { recursive: true, force: true }); } catch {}
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Path resolution behavior
  // ──────────────────────────────────────────────────────────────────────────

  it("EVENTS_DIR is lazy: same module, switching workspace switches the path", () => {
    // No snapshot at module-load: switching the workspace must change what
    // the next appendEvent writes into.
    bothInit(tmpA);
    eventStore.appendEvent(makeDeliberationEvent("deliberation:proposed", "delib-A"));
    const fileA = path.join(tmpA, ".zana", "events", "bus-events.ndjson");
    expect(fs.existsSync(fileA)).toBe(true);
    expect(fs.readFileSync(fileA, "utf8")).toContain("delib-A");

    // Switch to workspace B without recreating the events/store module.
    resetWorkspace();
    bothInit(tmpB);
    eventStore.appendEvent(makeDeliberationEvent("deliberation:converged", "delib-B"));

    const fileB = path.join(tmpB, ".zana", "events", "bus-events.ndjson");
    expect(fs.existsSync(fileB)).toBe(true);
    const contentB = fs.readFileSync(fileB, "utf8");
    expect(contentB).toContain("delib-B");
    // …and B's converged event is NOT in A.
    expect(fs.readFileSync(fileA, "utf8")).not.toContain("delib-B");
    // …and A's proposed event is NOT in B.
    expect(contentB).not.toContain("delib-A");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // The snapshot bug, directly
  // ──────────────────────────────────────────────────────────────────────────

  it("events/store imported BEFORE workspaceContext.init() still routes to the workspace dir", () => {
    // The top-of-file `import * as eventStore from ".../events/store.ts"`
    // already proves this: that import ran during module load, BEFORE this
    // describe-block's beforeEach() ran workspaceContext.init(). Under the
    // old bug, store.ts would have captured the global EVENTS_DIR at that
    // moment and pinned every appendEvent there forever.
    //
    // Now confirm: append after init, and verify the file lands in the
    // workspace, NOT in the (shimmed) global ~/.zana/events.
    bothInit(tmpA);
    eventStore.appendEvent(
      makeDeliberationEvent("deliberation:vote", "delib-late-init"),
    );

    const workspaceFile = path.join(tmpA, ".zana", "events", "bus-events.ndjson");
    expect(fs.existsSync(workspaceFile)).toBe(true);
    expect(fs.readFileSync(workspaceFile, "utf8")).toContain("delib-late-init");

    // Critically: NOTHING should have been written to the global fallback.
    const globalEventsDir = path.join(homeShim, ".zana", "events");
    if (fs.existsSync(globalEventsDir)) {
      const entries = fs.readdirSync(globalEventsDir);
      expect(entries).toEqual([]);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Cross-tenant correlation surface, eliminated
  // ──────────────────────────────────────────────────────────────────────────

  it("two workspaces emitting deliberation:* events keep their files disjoint", () => {
    // Workspace A: full deliberation cycle.
    bothInit(tmpA);
    eventStore.appendEvent(makeDeliberationEvent("deliberation:proposed", "delib-A"));
    eventStore.appendEvent(makeDeliberationEvent("deliberation:vote", "delib-A"));
    eventStore.appendEvent(makeDeliberationEvent("deliberation:synthesis", "delib-A"));
    eventStore.appendEvent(makeDeliberationEvent("deliberation:converged", "delib-A"));

    // Workspace B: independent deliberation.
    resetWorkspace();
    bothInit(tmpB);
    eventStore.appendEvent(makeDeliberationEvent("deliberation:proposed", "delib-B"));
    eventStore.appendEvent(makeDeliberationEvent("deliberation:escalated", "delib-B"));
    eventStore.appendEvent(makeDeliberationEvent("deliberation:override", "delib-B"));

    const fileA = path.join(tmpA, ".zana", "events", "bus-events.ndjson");
    const fileB = path.join(tmpB, ".zana", "events", "bus-events.ndjson");
    expect(fs.existsSync(fileA)).toBe(true);
    expect(fs.existsSync(fileB)).toBe(true);

    const contentA = fs.readFileSync(fileA, "utf8");
    const contentB = fs.readFileSync(fileB, "utf8");

    // A's file has all 4 of A's events (one ndjson line each)…
    expect(contentA.split("\n").filter((l) => l.includes("delib-A")).length).toBe(4);
    // …and zero of B's.
    expect(contentA).not.toContain("delib-B");

    // B's file has all 3 of B's events (one ndjson line each)…
    expect(contentB.split("\n").filter((l) => l.includes("delib-B")).length).toBe(3);
    // …and zero of A's.
    expect(contentB).not.toContain("delib-A");

    // Global fallback received nothing from either workspace.
    const globalEventsDir = path.join(homeShim, ".zana", "events");
    if (fs.existsSync(globalEventsDir)) {
      const entries = fs.readdirSync(globalEventsDir);
      expect(entries).toEqual([]);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Mid-run reset (governance assertion: once flipped, no global writes)
  // ──────────────────────────────────────────────────────────────────────────

  it("toggling workspaces mid-process does not leak prior events to the global fallback", () => {
    // Initialize A, append, then reset and re-init to B. Confirm that
    // through the entire cycle, nothing landed in the (shimmed) global dir.
    bothInit(tmpA);
    eventStore.appendEvent(makeDeliberationEvent("deliberation:proposed", "A1"));

    resetWorkspace();
    bothInit(tmpB);
    eventStore.appendEvent(makeDeliberationEvent("deliberation:proposed", "B1"));
    eventStore.appendEvent(makeDeliberationEvent("deliberation:converged", "B1"));

    const globalEventsDir = path.join(homeShim, ".zana", "events");
    if (fs.existsSync(globalEventsDir)) {
      // Allowed: directory may have been pre-created by some unrelated
      // bootstrap. NOT allowed: any bus-events.ndjson with our events in it.
      const eventsFile = path.join(globalEventsDir, "bus-events.ndjson");
      if (fs.existsSync(eventsFile)) {
        const content = fs.readFileSync(eventsFile, "utf8");
        expect(content).not.toContain("A1");
        expect(content).not.toContain("B1");
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Sanity: workspaceContext.getProjectPaths().eventsDir tracks the active
  // workspace (events/store consumes it directly now that the deprecated
  // config.EVENTS_DIR getter has been retired).
  // ──────────────────────────────────────────────────────────────────────────

  it("workspaceContext.getProjectPaths().eventsDir tracks the active workspace", () => {
    bothInit(tmpA);
    const afterA = wcDist.getProjectPaths().eventsDir;
    expect(afterA).toBe(path.join(tmpA, ".zana", "events"));

    resetWorkspace();
    bothInit(tmpB);
    const afterB = wcDist.getProjectPaths().eventsDir;
    expect(afterB).toBe(path.join(tmpB, ".zana", "events"));
    expect(afterB).not.toBe(afterA);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Broadened gate (decision 2026-06-04): writes refuse the global fallback
  // ──────────────────────────────────────────────────────────────────────────

  it("appendEvent throws WorkspaceNotInitializedError when workspace not initialized", () => {
    resetWorkspace();
    // events/store.ts imports workspaceContext from the TS source path, so
    // the thrown error's class identity matches the TS instance — not the
    // dist instance that `(core as any).project.workspaceContext` exposes.
    const ErrCtor = (workspaceContextTs as any).WorkspaceNotInitializedError;
    expect((workspaceContextTs as any).isInitialized()).toBe(false);

    let caught: any = null;
    try {
      eventStore.appendEvent(makeDeliberationEvent("deliberation:proposed", "blocked"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ErrCtor);
    expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");

    // Nothing should have been written to the global fallback either.
    const globalEventsFile = path.join(homeShim, ".zana", "events", "bus-events.ndjson");
    expect(fs.existsSync(globalEventsFile)).toBe(false);
  });
});
