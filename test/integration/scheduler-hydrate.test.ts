import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";
import * as schedulerStore from "@zana-ai/work/src/scheduling/store.ts";
import { serializeYaml } from "@zana-ai/work/src/scheduling/yaml-format.ts";

// Same dir resolution that store.ts will use when workspace-context is not
// initialized: ~/.zana/scheduler.
const SCHEDULER_DIR = path.join(os.homedir(), ".zana", "scheduler");
const PREFIX = `hyd-test-${Date.now()}`;

function writeYaml(id: string, schedule: any) {
  fs.mkdirSync(SCHEDULER_DIR, { recursive: true });
  const fpath = path.join(SCHEDULER_DIR, `${id}.yml`);
  fs.writeFileSync(fpath, serializeYaml(schedule), "utf8");
  return fpath;
}

function cleanupPrefixed() {
  try {
    const files = fs.readdirSync(SCHEDULER_DIR);
    for (const f of files) {
      if (f.startsWith(PREFIX)) {
        try { fs.unlinkSync(path.join(SCHEDULER_DIR, f)); } catch {}
      }
    }
  } catch {}
}

describe("scheduler hydrate-from-disk", () => {
  beforeEach(() => {
    cleanupPrefixed();
  });

  afterEach(() => {
    schedulerService.stopAll();
    cleanupPrefixed();
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
  });
});
