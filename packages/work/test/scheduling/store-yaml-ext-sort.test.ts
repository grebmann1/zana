// Two behaviors of scheduling/store.listSchedules() not covered by store.test.ts:
//
//   1. .yaml extension (in addition to .yml) — listSchedules uses
//      `f.endsWith(".yml") || f.endsWith(".yaml")` so any schedule file named
//      `<id>.yaml` (rather than <id>.yml) is picked up. No existing test
//      places a .yaml file in the scheduler dir.
//
//   2. updatedAt sort order — listSchedules sorts by updatedAt descending so
//      the most-recently-updated schedule comes first. The store.test.ts cases
//      never insert more than one schedule with distinct timestamps, so the
//      comparator is effectively dead in every passing test.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContextTs from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/work/src/scheduling/store.ts";

// ── workspace helpers (matches pattern in store.test.ts) ───────────────────

const wcDist: any =
  (core as any).project?.workspaceContext ??
  (core as any).default?.project?.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (wc && typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

function initWorkspace(root: string) {
  fs.mkdirSync(path.join(root, ".zana"), { recursive: true });
  workspaceContextTs.init(root);
  if (wcDist && typeof wcDist.init === "function") wcDist.init(root);
}

function schedulerDir(): string {
  return wcDist.getProjectPaths().schedulerDir as string;
}

// ── fixture ────────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-sched-yaml-sort-"));
  initWorkspace(tmpRoot);
});

afterEach(() => {
  resetWorkspace();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── .yaml extension support ────────────────────────────────────────────────

describe("listSchedules — .yaml extension", () => {
  it("picks up a schedule stored in a .yaml file (not just .yml)", () => {
    // Manually write a schedule file with the .yaml extension, bypassing
    // saveScheduleYaml (which only writes .yml). This exercises the
    // `f.endsWith(".yaml")` branch in listSchedules's first YAML pass.
    store.ensureDir();
    const sched = { id: "ext-yaml", every: "1h", updatedAt: "2024-06-01T00:00:00Z" };
    fs.writeFileSync(
      path.join(schedulerDir(), "ext-yaml.yaml"),
      `id: ext-yaml\nevery: 1h\nupdatedAt: "2024-06-01T00:00:00Z"\n`,
      "utf8",
    );

    const list = store.listSchedules();
    expect(list.some((s) => s.id === "ext-yaml")).toBe(true);
    // Correctly marks .yaml files as yaml format.
    const entry = list.find((s) => s.id === "ext-yaml")!;
    expect(entry._format).toBe("yaml");
  });

  it("deduplicates .yaml and .yml when both exist for the same id — .yml (yamlPath) wins", () => {
    // saveScheduleYaml writes .yml; we additionally drop a .yaml file for the
    // same id. The first-pass YAML scan hits .yml first (directory order varies,
    // but both have the same id — the second encounter is ignored because the
    // id is already in byId). Either way only one entry should survive.
    store.ensureDir();
    store.saveScheduleYaml({ id: "dual-ext", every: "2h" });
    fs.writeFileSync(
      path.join(schedulerDir(), "dual-ext.yaml"),
      `id: dual-ext\nevery: 2h\n`,
      "utf8",
    );

    const list = store.listSchedules();
    const matches = list.filter((s) => s.id === "dual-ext");
    expect(matches).toHaveLength(1);
  });
});

// ── updatedAt sort order ───────────────────────────────────────────────────

describe("listSchedules — updatedAt descending sort", () => {
  it("returns schedules in newest-first order when updatedAt values differ", () => {
    // Write three schedules with distinct timestamps so the comparator is
    // exercised: oldest → middle → newest at write time, but the list must
    // come back newest-first.
    store.saveScheduleYaml({
      id: "oldest", every: "1h",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    store.saveScheduleYaml({
      id: "middle", every: "1h",
      updatedAt: "2024-06-01T00:00:00.000Z",
    });
    store.saveScheduleYaml({
      id: "newest", every: "1h",
      updatedAt: "2024-12-01T00:00:00.000Z",
    });

    const list = store.listSchedules();
    const ids = list.map((s) => s.id);
    const idxNewest = ids.indexOf("newest");
    const idxMiddle = ids.indexOf("middle");
    const idxOldest = ids.indexOf("oldest");

    expect(idxNewest).toBeLessThan(idxMiddle);
    expect(idxMiddle).toBeLessThan(idxOldest);
  });

  it("schedules without updatedAt sort after those that have it (treated as epoch 0)", () => {
    // A schedule with no updatedAt field gets `new Date(undefined || 0)` =
    // epoch 0 = 1970-01-01, so it should appear after any schedule that has
    // a real timestamp.
    store.saveScheduleYaml({
      id: "has-date", every: "1h",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    store.saveScheduleYaml({ id: "no-date", every: "1h" }); // no updatedAt

    const list = store.listSchedules();
    const ids = list.map((s) => s.id);
    expect(ids.indexOf("has-date")).toBeLessThan(ids.indexOf("no-date"));
  });
});
