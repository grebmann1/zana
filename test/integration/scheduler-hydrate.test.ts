import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as workspaceContextTs from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";
import * as schedulerStore from "@zana-ai/work/src/scheduling/store.ts";
import { serializeYaml } from "@zana-ai/work/src/scheduling/yaml-format.ts";

// Both the .ts source and the compiled dist may be different module instances;
// initialize and reset both to avoid cross-test bleed (same pattern as store.test.ts).
const wcDist: any = (core as any).project?.workspaceContext ?? (core as any).default?.project?.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (wc && typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

function initWorkspace(root: string) {
  // Pre-create .zana/ so resolveProjectDir stops here and does NOT walk up
  // to ~/.zana/ (which accumulates cross-test state and thousands of files).
  fs.mkdirSync(path.join(root, ".zana"), { recursive: true });
  workspaceContextTs.init(root);
  if (wcDist && typeof wcDist.init === "function") wcDist.init(root);
}

const PREFIX = `hyd-test-${Date.now()}`;
let tmpRoot: string;
let SCHEDULER_DIR: string;

function writeYaml(id: string, schedule: any) {
  fs.mkdirSync(SCHEDULER_DIR, { recursive: true });
  const fpath = path.join(SCHEDULER_DIR, `${id}.yml`);
  fs.writeFileSync(fpath, serializeYaml(schedule), "utf8");
  return fpath;
}

describe("scheduler hydrate-from-disk", { timeout: 20000 }, () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-hydrate-"));
    initWorkspace(tmpRoot);
    SCHEDULER_DIR = wcDist.getProjectPaths().schedulerDir as string;
    fs.mkdirSync(SCHEDULER_DIR, { recursive: true });
  });

  afterEach(() => {
    schedulerService.stopAll();
    resetWorkspace();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("loads enabled YAML schedules and registers triggers", () => {
    writeYaml(`${PREFIX}-1`, {
      id: `${PREFIX}-1`,
      name: `${PREFIX} cron 1`,
      enabled: true,
      schedule: { cron: "* * * * *" },
      action: { type: "command", command: "echo a" },
      updatedAt: new Date().toISOString(),
    });
    writeYaml(`${PREFIX}-2`, {
      id: `${PREFIX}-2`,
      name: `${PREFIX} interval 2`,
      enabled: true,
      schedule: { intervalMs: 60_000 },
      action: { type: "command", command: "echo b" },
      updatedAt: new Date().toISOString(),
    });
    // disabled — should NOT be started
    writeYaml(`${PREFIX}-3`, {
      id: `${PREFIX}-3`,
      name: `${PREFIX} disabled 3`,
      enabled: false,
      schedule: { cron: "0 0 * * *" },
      action: { type: "command", command: "echo c" },
      updatedAt: new Date().toISOString(),
    });

    // Sanity check: store sees them
    const all = schedulerStore.listSchedules();
    const myIds = all.filter((s) => s.id?.startsWith(PREFIX)).map((s) => s.id);
    expect(myIds).toContain(`${PREFIX}-1`);
    expect(myIds).toContain(`${PREFIX}-2`);
    expect(myIds).toContain(`${PREFIX}-3`);

    schedulerService.loadFromDisk();

    const active = schedulerService._getActiveTriggers();
    const ids = active.map((t: any) => t.scheduleId);
    expect(ids).toContain(`${PREFIX}-1`);
    expect(ids).toContain(`${PREFIX}-2`);
    expect(ids).not.toContain(`${PREFIX}-3`);

    const cron = active.find((t: any) => t.scheduleId === `${PREFIX}-1`);
    expect(cron?.kind).toBe("cron");
    const interval = active.find((t: any) => t.scheduleId === `${PREFIX}-2`);
    expect(interval?.kind).toBe("interval");
  });

  it("is idempotent — calling loadFromDisk twice does not double-register", () => {
    writeYaml(`${PREFIX}-idem`, {
      id: `${PREFIX}-idem`,
      name: `${PREFIX} idempotent`,
      enabled: true,
      schedule: { intervalMs: 30_000 },
      action: { type: "command", command: "echo i" },
      updatedAt: new Date().toISOString(),
    });

    schedulerService.loadFromDisk();
    schedulerService.loadFromDisk();

    const active = schedulerService._getActiveTriggers();
    const matches = active.filter((t: any) => t.scheduleId === `${PREFIX}-idem`);
    expect(matches.length).toBe(1);
  }, 30_000);
});
