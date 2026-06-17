// listRuns resilience — the existing workflow-engine.test.ts covers the happy
// paths (empty dir, valid files, status filter). This file covers the two
// defensive branches that are otherwise untested:
//   1. a run file that exists but contains corrupt JSON is skipped, not thrown
//      (the per-file `try { JSON.parse } catch { return null }` + `.filter(Boolean)`)
//   2. a non-`.json` entry in the workflows dir is ignored (the `.endsWith` filter)
// A single bad file must not take down the whole listing.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import { listRuns } from "@zana-ai/work/src/scheduling/workflow-engine.ts";

// workspace-context has two module instances under vitest (the TS-source import
// above and the dist CJS one reached via require("@zana-ai/core") inside the
// production code). Both singletons must be reset/initialized together — see
// the note in workflow-engine.test.ts.
const wcDist: any = (core as any).project.workspaceContext;
function resetWorkspace() {
  for (const wc of [workspaceContext as any, wcDist]) {
    try { if (typeof wc._resetForTesting === "function") wc._resetForTesting(); } catch {}
  }
}
function initWorkspace(root: string) {
  for (const wc of [workspaceContext as any, wcDist]) {
    try { wc.init(root); } catch {}
  }
}

const TEST_WS = path.join(os.tmpdir(), `zana-test-wfe-skip-${Date.now()}-${process.pid}`);

function workflowsDir() {
  return path.join(workspaceContext.getProjectPaths().projectDir, "workflows");
}

describe("listRuns — skips invalid files", () => {
  beforeEach(() => {
    resetWorkspace();
    // Pre-create the .zana dir so resolveProjectDir anchors here and does not
    // walk up to /tmp/.zana (the global Zana state dir that exists on this host).
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
  });
  afterEach(() => {
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("returns the valid runs and silently drops a corrupt-JSON run file", () => {
    const dir = workflowsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "good.json"),
      JSON.stringify({ id: "good", status: "completed", skillId: "s1" }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not valid json", "utf8");

    const runs = listRuns();
    expect(runs.map((r: any) => r.id)).toEqual(["good"]);
  });

  it("ignores non-.json entries in the workflows dir", () => {
    const dir = workflowsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "r1.json"),
      JSON.stringify({ id: "r1", status: "failed", skillId: "s1" }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me", "utf8");

    const runs = listRuns();
    expect(runs.map((r: any) => r.id)).toEqual(["r1"]);
  });

  it("returns [] when every run file is corrupt", () => {
    const dir = workflowsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.json"), "}{", "utf8");
    fs.writeFileSync(path.join(dir, "b.json"), "not json at all", "utf8");

    expect(listRuns()).toEqual([]);
  });
});
