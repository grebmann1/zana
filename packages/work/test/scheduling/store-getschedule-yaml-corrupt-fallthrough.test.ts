// getSchedule — YAML-present-but-unusable → JSON fallthrough.
//
// packages/work/src/scheduling/store.ts getSchedule() (lines 125-146):
//   - reads `<id>.yml`; if it parses to an object WITH an `id`, returns it.
//   - OTHERWISE it must fall through to `<id>.json` and return that instead.
//
// The existing store.test.ts only covers the happy YAML paths and the
// "YAML wins when BOTH are valid" case. It never exercises the fallthrough:
// a YAML file that exists on disk but is unusable (no `id`, or not a YAML
// object at all) must NOT shadow a valid JSON schedule for the same id, and
// must NOT cause getSchedule to throw. parseYaml() returns null for a bare
// scalar and an id-less object for a mapping with no `id:` — both land on the
// fallthrough branch. This file pins that contract.
//
// Deterministic: real FS under a fresh tmp workspace, no network, no real Claude.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContextTs from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/work/src/scheduling/store.ts";

const wcDist: any = (core as any).project?.workspaceContext ?? (core as any).default?.project?.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (wc && typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

function initWorkspace(root: string) {
  mkdirSync(join(root, ".zana"), { recursive: true });
  workspaceContextTs.init(root);
  if (wcDist && typeof wcDist.init === "function") wcDist.init(root);
}

describe("scheduling/store — getSchedule YAML fallthrough to JSON", () => {
  let tmpRoot: string;

  function schedulerDir() {
    return wcDist.getProjectPaths().schedulerDir as string;
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-sched-fallthrough-"));
    initWorkspace(tmpRoot);
  });

  afterEach(() => {
    resetWorkspace();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("returns the JSON schedule when the YAML file has no id", () => {
    // Valid JSON schedule for id "ft1" ...
    store.saveSchedule({ id: "ft1", every: "5m" });
    // ... plus a YAML file at the same id that parses but lacks `id`.
    writeFileSync(join(schedulerDir(), "ft1.yml"), "every: 30m\n", "utf8");

    const loaded = store.getSchedule("ft1");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("ft1");
    expect(loaded!._format).toBe("json");
    // The JSON value wins — not the shadowing YAML's "30m".
    expect(loaded!.every).toBe("5m");
  });

  it("returns the JSON schedule when the YAML file is not a YAML object (bare scalar)", () => {
    store.saveSchedule({ id: "ft2", every: "1h" });
    // A bare scalar makes parseYaml() return null → fallthrough.
    writeFileSync(join(schedulerDir(), "ft2.yml"), "just-a-scalar-string", "utf8");

    const loaded = store.getSchedule("ft2");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("ft2");
    expect(loaded!._format).toBe("json");
  });

  it("returns null (no throw) when the YAML is unusable and no JSON exists", () => {
    // Only an id-less YAML file on disk, no JSON counterpart.
    store.ensureDir();
    writeFileSync(join(schedulerDir(), "ft3.yml"), "every: 15m\n", "utf8");

    expect(() => store.getSchedule("ft3")).not.toThrow();
    expect(store.getSchedule("ft3")).toBeNull();
  });
});
