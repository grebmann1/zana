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
        try { fs.unlinkSync(path.join(SCHEDULER_DIR, f)); } catch {}
      }
    }
  } catch {}
  // Also clean by reading content (json files)
  try {
    const files = fs.readdirSync(SCHEDULER_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".history.json"));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SCHEDULER_DIR, f), "utf8"));
        if (data.name?.startsWith(PREFIX) || data.id?.startsWith(PREFIX)) {
          fs.unlinkSync(path.join(SCHEDULER_DIR, f));
          try { fs.unlinkSync(path.join(SCHEDULER_DIR, f.replace(".json", ".history.json"))); } catch {}
        }
      } catch {}
    }
  } catch {}
  // Clean YAML files matching prefix
  try {
    const files = fs.readdirSync(SCHEDULER_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    for (const f of files) {
      if (f.startsWith(PREFIX)) {
        try { fs.unlinkSync(path.join(SCHEDULER_DIR, f)); } catch {}
        continue;
      }
      try {
        const content = fs.readFileSync(path.join(SCHEDULER_DIR, f), "utf8");
        if (content.includes(PREFIX)) {
          fs.unlinkSync(path.join(SCHEDULER_DIR, f));
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

  it("YAML save -> list -> get roundtrip", () => {
    const id = `${PREFIX}-yaml-1`;
    const schedule = {
      id,
      name: `${PREFIX}-yaml-roundtrip`,
      description: "yaml format",
      enabled: true,
      schedule: { cron: "0 2 * * *" },
      action: { type: "spawn-agent", profileId: "test-writer", prompt: "scan tests" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    schedulerStore.saveScheduleYaml(schedule);

    // File should be on disk as .yml
    expect(fs.existsSync(path.join(SCHEDULER_DIR, `${id}.yml`))).toBe(true);

    const got = schedulerStore.getSchedule(id);
    expect(got).not.toBeNull();
    expect(got.name).toBe(`${PREFIX}-yaml-roundtrip`);
    expect(got.schedule.cron).toBe("0 2 * * *");
    expect(got.action.profileId).toBe("test-writer");
    expect(got._format).toBe("yaml");

    const all = schedulerStore.listSchedules();
    expect(all.some((s) => s.id === id)).toBe(true);
  });

  it("JSON schedules remain readable", () => {
    const id = `${PREFIX}-json-back-compat`;
    schedulerStore.saveSchedule({
      id,
      name: `${PREFIX}-json-back-compat`,
      cron: "*/10 * * * *",
      intervalMs: null,
      action: { type: "command", command: "echo legacy" },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const got = schedulerStore.getSchedule(id);
    expect(got).not.toBeNull();
    expect(got.cron).toBe("*/10 * * * *");
    expect(got._format).toBe("json");
  });

  it("YAML and JSON schedules coexist in listSchedules", () => {
    const yamlId = `${PREFIX}-coexist-yaml`;
    const jsonId = `${PREFIX}-coexist-json`;

    schedulerStore.saveScheduleYaml({
      id: yamlId,
      name: `${PREFIX}-coexist-yaml`,
      enabled: true,
      schedule: { cron: "* * * * *" },
      action: { type: "command", command: "echo y" },
      updatedAt: new Date().toISOString(),
    });
    schedulerStore.saveSchedule({
      id: jsonId,
      name: `${PREFIX}-coexist-json`,
      enabled: true,
      cron: "0 * * * *",
      action: { type: "command", command: "echo j" },
      updatedAt: new Date().toISOString(),
    });

    const all = schedulerStore.listSchedules();
    const ids = all.map((s) => s.id);
    expect(ids).toContain(yamlId);
    expect(ids).toContain(jsonId);
  });

  it("YAML wins when both .yml and .json exist for the same id", () => {
    const id = `${PREFIX}-yaml-wins`;
    // Drop two files manually with the same id but different name fields.
    fs.writeFileSync(
      path.join(SCHEDULER_DIR, `${id}.json`),
      JSON.stringify({
        id,
        name: `${PREFIX}-from-json`,
        enabled: true,
        cron: "0 0 * * *",
        action: { type: "command", command: "echo j" },
        updatedAt: new Date().toISOString(),
      }, null, 2),
      "utf8"
    );
    schedulerStore.saveScheduleYaml({
      id,
      name: `${PREFIX}-from-yaml`,
      enabled: true,
      schedule: { cron: "* * * * *" },
      action: { type: "command", command: "echo y" },
      updatedAt: new Date().toISOString(),
    });

    const got = schedulerStore.getSchedule(id);
    expect(got.name).toBe(`${PREFIX}-from-yaml`);

    const all = schedulerStore.listSchedules();
    const matches = all.filter((s) => s.id === id);
    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe(`${PREFIX}-from-yaml`);
  });

  it("deleteSchedule removes both .yml and .json artifacts", () => {
    const id = `${PREFIX}-delete-both`;
    schedulerStore.saveSchedule({
      id,
      name: `${PREFIX}-delete-both`,
      enabled: true,
      action: { type: "command" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    schedulerStore.saveScheduleYaml({
      id,
      name: `${PREFIX}-delete-both-yaml`,
      enabled: true,
      schedule: { cron: "* * * * *" },
      action: { type: "command", command: "echo x" },
      updatedAt: new Date().toISOString(),
    });

    schedulerStore.deleteSchedule(id);
    expect(fs.existsSync(path.join(SCHEDULER_DIR, `${id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(SCHEDULER_DIR, `${id}.yml`))).toBe(false);
    expect(schedulerStore.getSchedule(id)).toBeNull();
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
