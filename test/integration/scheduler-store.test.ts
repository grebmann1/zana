import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SCHEDULER_DIR = path.join(os.homedir(), ".zana", "scheduler");

import * as schedulerStore from "@zana/work/src/scheduling/store.ts";

const PREFIX = `test-sched-${Date.now()}`;

function cleanup() {
  try {
    const files = fs.readdirSync(SCHEDULER_DIR);
    for (const f of files) {
      if (f.startsWith(PREFIX)) {
        fs.unlinkSync(path.join(SCHEDULER_DIR, f));
      }
    }
  } catch {}
  // Also clean by reading content
  try {
    const files = fs.readdirSync(SCHEDULER_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".history.json"));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SCHEDULER_DIR, f), "utf8"));
        if (data.name?.startsWith(PREFIX)) {
          fs.unlinkSync(path.join(SCHEDULER_DIR, f));
          try { fs.unlinkSync(path.join(SCHEDULER_DIR, f.replace(".json", ".history.json"))); } catch {}
        }
      } catch {}
    }
  } catch {}
}

describe("scheduler-store", () => {
  afterEach(cleanup);

  it("saves and retrieves a schedule", () => {
    const schedule = {
      id: `${PREFIX}-1`,
      name: `${PREFIX}-test-schedule`,
      cron: "*/5 * * * *",
      intervalMs: null,
      action: { type: "command", command: "echo hi" },
      enabled: true,
      ownerId: "test",
      lastRunAt: null,
      lastRunResult: null,
      nextRunAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    schedulerStore.saveSchedule(schedule);
    const found = schedulerStore.getSchedule(`${PREFIX}-1`);
    expect(found.name).toBe(`${PREFIX}-test-schedule`);
    expect(found.cron).toBe("*/5 * * * *");
  });

  it("lists schedules", () => {
    schedulerStore.saveSchedule({
      id: `${PREFIX}-2`,
      name: `${PREFIX}-list-test`,
      action: { type: "prompt" },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const all = schedulerStore.listSchedules();
    expect(all.some((s) => s.id === `${PREFIX}-2`)).toBe(true);
  });

  it("deletes a schedule and its history", () => {
    schedulerStore.saveSchedule({
      id: `${PREFIX}-3`,
      name: `${PREFIX}-delete-test`,
      action: { type: "command" },
      enabled: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    schedulerStore.appendRunResult(`${PREFIX}-3`, {
      status: "success",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });

    schedulerStore.deleteSchedule(`${PREFIX}-3`);
    expect(schedulerStore.getSchedule(`${PREFIX}-3`)).toBeNull();
    expect(schedulerStore.getRunHistory(`${PREFIX}-3`)).toEqual([]);
  });

  it("appends run results up to max", () => {
    const id = `${PREFIX}-4`;
    schedulerStore.saveSchedule({
      id,
      name: `${PREFIX}-history`,
      action: { type: "command" },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    for (let i = 0; i < 15; i++) {
      schedulerStore.appendRunResult(id, {
        status: "success",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        output: `run-${i}`,
      });
    }

    const history = schedulerStore.getRunHistory(id);
    expect(history.length).toBe(10);
    expect(history[0].output).toBe("run-5");
  });
});
