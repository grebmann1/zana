// FU-T2d / FU-T4c / FU-config-5 — tenant isolation gate.
//
// CAS writes and kind=deliberation checkpoint writes must REFUSE to fall
// back to the global ~/.zana/* namespace when no workspace is initialized.
// Reads of pre-existing global-scope state stay open (so legacy data is
// still inspectable) — only WRITES from a non-bootstrapped workspace are
// blocked. Other checkpoint kinds ("run", legacy autopilot/team flows)
// are unaffected.
//
// The artifact-store and checkpoint store reach @zana-ai/core via require(),
// which resolves to the dist build under vitest. We initialize BOTH module
// instances (the TS-imported one and the dist-resolved one) where it
// matters, and we read the WorkspaceNotInitializedError class off the
// dist instance for `instanceof` checks (same class identity as the source
// throws).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContextTs from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as artifactStore from "@zana-ai/work/src/runs/artifact-store.ts";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";

// Pull the class from the dist instance — that is the one the production
// code constructs. The .ts-imported instance has its OWN class object; an
// instanceof against it would fail even though the error name/code match.
const WorkspaceNotInitializedError = (core as any).project.workspaceContext
  .WorkspaceNotInitializedError;

const wcDist: any = (core as any).project.workspaceContext;

function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Reset both workspace-context module instances back to "uninitialized".
// `_resetForTesting()` is the documented test-only escape hatch on the
// singleton — required because the artifact-store / checkpoint store reach
// @zana-ai/core via require() (dist instance) while the test file imports the
// .ts source (separate instance). Both must be flipped together.
function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

describe("tenant-isolation gate (FU-T2d / FU-T4c / FU-config-5)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    resetWorkspace();
    tmpRoot = makeTmp("zana-tenant-iso-");
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  // ─── CAS write gate ──────────────────────────────────────────────────────

  it("storeContentAddressed throws WorkspaceNotInitializedError when workspace not initialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    let caught: any = null;
    try {
      artifactStore.storeContentAddressed("rationale that would leak");
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(WorkspaceNotInitializedError);
    expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
    expect(caught.operation).toBe("store");
    expect(typeof caught.path).toBe("string");
    expect(caught.path.length).toBeGreaterThan(0);
  });

  it("storeContentAddressed succeeds when workspace IS initialized", () => {
    workspaceContextTs.init(tmpRoot);
    wcDist.init(tmpRoot);

    const result = artifactStore.storeContentAddressed("ok payload");
    expect(result.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.size).toBeGreaterThan(0);
    // Verify we can read it back.
    const back = artifactStore.readContentAddressed(result.hash);
    expect(back).not.toBeNull();
    expect(back!.toString("utf8")).toBe("ok payload");
  });

  it("readContentAddressed works against global fallback even when workspace not initialized", () => {
    // First, write a blob WITH workspace initialized so it actually lands.
    workspaceContextTs.init(tmpRoot);
    wcDist.init(tmpRoot);
    const { hash } = artifactStore.storeContentAddressed("read-side-ok");
    expect(artifactStore.hasContentAddressed(hash)).toBe(true);

    // Now drop back to "uninitialized" and confirm reads still resolve.
    // The read path resolves the artifacts dir via getArtifactsDir() which
    // uses the global fallback when uninitialized — our gate ONLY blocks
    // writes, so this read continues to point at the workspace dir for
    // this test. Verify via the global-fallback path explicitly: we re-hash
    // and re-write directly into the uninitialized fallback, then read.
    resetWorkspace();
    expect(wcDist.isInitialized()).toBe(false);

    // Plant a blob in the global fallback the same way the read path
    // would resolve it (under config.ZANA_DIR/artifacts/blobs/<aa>/<rest>.bin).
    const ZANA_DIR = (core as any).config.ZANA_DIR;
    const fakeHex = "a".repeat(64);
    const fakeHash = `sha256:${fakeHex}`;
    const dir = path.join(ZANA_DIR, "artifacts", "blobs", fakeHex.slice(0, 2));
    const file = path.join(dir, `${fakeHex.slice(2)}.bin`);
    // Don't actually plant — that would pollute the user's ~/.zana. Instead
    // assert that the read path gracefully returns null for a non-existent
    // global blob without throwing the gate. That is the read-side OK
    // contract: reads do NOT throw WorkspaceNotInitializedError.
    let threw: any = null;
    try {
      const r = artifactStore.readContentAddressed(fakeHash);
      expect(r).toBeNull();
      const h = artifactStore.hasContentAddressed(fakeHash);
      expect(h).toBe(false);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeNull();
    void dir; void file;
  });

  // ─── Checkpoint write gate ───────────────────────────────────────────────

  it("checkpoint.save({kind:'deliberation'}) throws when workspace not initialized", () => {
    // Need a checkpointsDir that doesn't depend on workspaceContext —
    // bind it directly via init() so the gate (not a missing dir) is
    // what fails. The gate runs BEFORE the dir is touched.
    checkpointStore.init(tmpRoot);
    expect(wcDist.isInitialized()).toBe(false);

    let caught: any = null;
    try {
      checkpointStore.save({
        id: "delib-blocked",
        kind: "deliberation",
        deliberation: { id: "delib-blocked" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(WorkspaceNotInitializedError);
    expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
    expect(caught.operation).toBe("write");
    expect(caught.requestedKind).toBe("deliberation");

    // No file should have been written.
    const expectedPath = path.join(tmpRoot, "checkpoints", "delib-blocked.json");
    expect(fs.existsSync(expectedPath)).toBe(false);
  });

  it("checkpoint.save({kind:'run'}) succeeds when workspace not initialized (legacy autopilot/team unaffected)", () => {
    checkpointStore.init(tmpRoot);
    expect(wcDist.isInitialized()).toBe(false);

    const cp = checkpointStore.save({
      id: "run-ok",
      kind: "run",
      teamId: "t",
      runId: "r",
    });
    expect(cp.id).toBe("run-ok");
    expect(cp.kind).toBe("run");

    // Default-kind save (omitting kind) also OK — backfilled to "run".
    const cp2 = checkpointStore.save({ id: "default-ok", teamId: "t2" });
    expect(cp2.kind).toBe("run");

    // And the files actually exist on disk.
    expect(fs.existsSync(path.join(tmpRoot, "checkpoints", "run-ok.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, "checkpoints", "default-ok.json"))).toBe(true);
  });

  it("checkpoint.save({kind:'deliberation'}) succeeds when workspace IS initialized", () => {
    workspaceContextTs.init(tmpRoot);
    wcDist.init(tmpRoot);
    checkpointStore.init(tmpRoot);

    const cp = checkpointStore.save({
      id: "delib-ok",
      kind: "deliberation",
      deliberation: { id: "delib-ok", state: "PROPOSED" },
      expiresAt: Date.now() + 60_000,
    });
    expect(cp.id).toBe("delib-ok");
    expect(cp.kind).toBe("deliberation");
    expect(fs.existsSync(path.join(tmpRoot, "checkpoints", "delib-ok.json"))).toBe(true);
  });

  it("checkpoint.load works against global fallback even when workspace not initialized", () => {
    // Plant a checkpoint while initialized…
    workspaceContextTs.init(tmpRoot);
    wcDist.init(tmpRoot);
    checkpointStore.init(tmpRoot);
    checkpointStore.save({
      id: "read-side-ok",
      kind: "deliberation",
      deliberation: { id: "read-side-ok" },
    });

    // …then drop the workspace state and confirm the read still works.
    resetWorkspace();
    expect(wcDist.isInitialized()).toBe(false);

    const loaded = checkpointStore.load("read-side-ok");
    expect(loaded).not.toBeNull();
    expect(loaded.id).toBe("read-side-ok");
    expect(loaded.kind).toBe("deliberation");

    // list() also unaffected.
    const all = checkpointStore.list({ kind: "deliberation" });
    expect(all.find((r: any) => r.id === "read-side-ok")).toBeTruthy();
  });
});
