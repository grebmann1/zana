// Scheduler service lifecycle tests — create / enable / disable / trigger /
// loadFromDisk / stopAll / inflight TTL / agent-termination inlining.
//
// Uses fake timers for the trigger backends so tests don't sleep.
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";

// Service module is loaded after workspace init so its require() of
// @zana-ai/core resolves the same instance the test seeded.
import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";
import * as schedulerStore from "@zana-ai/work/src/scheduling/store.ts";
import { serializeYaml } from "@zana-ai/work/src/scheduling/yaml-format.ts";
import { EventEmitter } from "node:events";

function fakeProfile(id: string) {
  return { id, displayName: id, model: "claude-sonnet-4-6" };
}

describe("scheduler service — CRUD and lifecycle", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-sched-"));
    // Pre-create .zana/ so resolveProjectDir stops here instead of walking up
    // to a parent that already has a .zana/ dir (e.g. /tmp/.zana/).
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    // Clean module-level trigger map between tests.
    schedulerService.stopAll();
  });

  afterEach(() => {
    schedulerService.stopAll();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("createSchedule writes YAML to disk and starts a trigger when enabled", () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const result = schedulerService.createSchedule({
      name: "test",
      every: "1m",
      action: { type: "command", command: ["echo", "hi"] },
      enabled: true,
    });
    expect(result.error).toBeUndefined();
    expect((result as any).id).toBeTruthy();

    const dir = join(tmpRoot, ".zana", "scheduler");
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith(".yml"))).toBe(true);

    // Trigger should be active
    const active = (schedulerService as any)._getActiveTriggers();
    expect(active).toHaveLength(1);
    expect(active[0].kind).toBe("interval");
    vi.useRealTimers();
  });

  it("createSchedule with enabled=false does NOT start a trigger", () => {
    schedulerService.createSchedule({
      name: "off",
      every: "1m",
      action: { type: "command", command: ["echo", "x"] },
      enabled: false,
    });
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(0);
  });

  it("createSchedule rejects schedule missing trigger when enabled", () => {
    const r = schedulerService.createSchedule({
      name: "no-trigger",
      action: { type: "command", command: ["echo", "x"] },
      enabled: true,
    });
    expect((r as any).error).toMatch(/invalid schedule/i);
  });

  it("createSchedule rejects unknown action type", () => {
    const r = schedulerService.createSchedule({
      name: "bad-action",
      every: "1m",
      action: { type: "evil-eval" } as any,
      enabled: true,
    });
    expect((r as any).error).toMatch(/invalid schedule/i);
  });

  it("disableSchedule stops the trigger and persists enabled=false", () => {
    const created = schedulerService.createSchedule({
      name: "to-disable",
      every: "1m",
      action: { type: "command", command: ["echo", "x"] },
      enabled: true,
    });
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(1);
    schedulerService.disableSchedule((created as any).id);
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(0);
    const reloaded = schedulerStore.getSchedule((created as any).id);
    expect(reloaded.enabled).toBe(false);
  });

  it("enableSchedule re-starts the trigger and persists enabled=true", () => {
    const created = schedulerService.createSchedule({
      name: "to-enable",
      every: "1m",
      action: { type: "command", command: ["echo", "x"] },
      enabled: false,
    });
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(0);
    schedulerService.enableSchedule((created as any).id);
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(1);
    const reloaded = schedulerStore.getSchedule((created as any).id);
    expect(reloaded.enabled).toBe(true);
  });

  it("enable/disable on missing id returns error", () => {
    expect((schedulerService.enableSchedule("nope") as any).error).toBe("schedule not found");
    expect((schedulerService.disableSchedule("nope") as any).error).toBe("schedule not found");
  });

  it("deleteSchedule stops trigger and removes file", () => {
    const created = schedulerService.createSchedule({
      name: "del",
      every: "1m",
      action: { type: "command", command: ["echo", "x"] },
      enabled: true,
    });
    schedulerService.deleteSchedule((created as any).id);
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(0);
    expect(schedulerStore.getSchedule((created as any).id)).toBeNull();
  });

  it("listSchedules returns all on-disk schedules", () => {
    schedulerService.createSchedule({
      name: "a", every: "1m",
      action: { type: "command", command: ["echo", "1"] }, enabled: false,
    });
    schedulerService.createSchedule({
      name: "b", every: "2m",
      action: { type: "command", command: ["echo", "2"] }, enabled: false,
    });
    const list = schedulerService.listSchedules();
    expect(list).toHaveLength(2);
  });

  it("updateSchedule preserves the on-disk format and re-arms trigger", () => {
    const created = schedulerService.createSchedule({
      name: "upd",
      every: "1m",
      action: { type: "command", command: ["echo", "x"] },
      enabled: true,
    });
    const r = schedulerService.updateSchedule((created as any).id, {
      schedule: { every: "5m" },
    });
    expect((r as any).ok).toBe(true);
    const reloaded = schedulerStore.getSchedule((created as any).id);
    expect(reloaded.schedule.every).toBe("5m");
    // Trigger should still be active (re-armed)
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(1);
  });

  it("updateSchedule on missing id returns error", () => {
    const r = schedulerService.updateSchedule("nope", { name: "x" });
    expect((r as any).error).toBe("schedule not found");
  });
});

describe("scheduler service — loadFromDisk / stopAll", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-sched-load-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    schedulerService.stopAll();
  });

  afterEach(() => {
    schedulerService.stopAll();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  function writeYamlSchedule(id: string, enabled: boolean, every = "1m") {
    schedulerStore.ensureDir();
    const dir = join(tmpRoot, ".zana", "scheduler");
    writeFileSync(
      join(dir, `${id}.yml`),
      serializeYaml({
        id, name: id, enabled,
        schedule: { every },
        action: { type: "command", command: ["echo", id] },
      }),
      "utf8",
    );
  }

  it("starts triggers only for enabled schedules", () => {
    writeYamlSchedule("a", true, "1m");
    writeYamlSchedule("b", false, "2m");
    writeYamlSchedule("c", true, "3m");

    const result = schedulerService.loadFromDisk();
    expect(result.total).toBe(3);
    expect(result.started).toBe(2);
    expect(result.skipped).toBe(1);
    expect((schedulerService as any)._getActiveTriggers().map((t: any) => t.scheduleId).sort())
      .toEqual(["a", "c"]);
  });

  it("loadFromDisk is idempotent — re-running stops then restarts triggers", () => {
    writeYamlSchedule("a", true, "1m");
    schedulerService.loadFromDisk();
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(1);
    schedulerService.loadFromDisk();
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(1);
  });

  it("stopAll() clears all active triggers", () => {
    writeYamlSchedule("a", true, "1m");
    writeYamlSchedule("b", true, "2m");
    schedulerService.loadFromDisk();
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(2);
    schedulerService.stopAll();
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(0);
  });
});

describe("scheduler service — triggerSchedule (manual fire)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-sched-fire-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    schedulerService.stopAll();
  });

  afterEach(() => {
    schedulerService.stopAll();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("command action fires execFile and records success in history", async () => {
    const created = schedulerService.createSchedule({
      name: "echo-test",
      every: "1m",
      action: { type: "command", command: ["echo", "hello"] },
      enabled: false, // we'll trigger manually
    });
    const r = await schedulerService.triggerSchedule((created as any).id);
    expect((r as any).ok).toBe(true);
    expect((r as any).result.status).toBe("success");
    expect((r as any).result.stdout).toMatch(/hello/);

    // History should have the entry
    const hist = schedulerStore.getRunHistory((created as any).id);
    expect(hist).toHaveLength(1);
    expect(hist[0].status).toBe("success");

    // Schedule should have updated runCount + lastRunResult
    const updated = schedulerStore.getSchedule((created as any).id);
    expect(updated.status.runCount).toBe(1);
    expect(updated.status.lastRunResult).toBe("success");
  });

  it("command action with bad binary records error", async () => {
    const created = schedulerService.createSchedule({
      name: "bad-cmd",
      every: "1m",
      action: { type: "command", command: ["this-binary-does-not-exist-xyz"] },
      enabled: false,
    });
    const r = await schedulerService.triggerSchedule((created as any).id);
    expect((r as any).result.status).toBe("error");
    const updated = schedulerStore.getSchedule((created as any).id);
    expect(updated.status.lastRunResult).toMatch(/^error/);
  });

  it("command action with shell-string form is rejected (security)", async () => {
    const created = schedulerService.createSchedule({
      name: "shell-string",
      every: "1m",
      action: { type: "command", command: "rm -rf /" } as any,
      enabled: false,
    });
    const r = await schedulerService.triggerSchedule((created as any).id);
    expect((r as any).result.status).toBe("error");
    expect((r as any).result.error).toMatch(/array of strings|shell strings are rejected/i);
  });

  it("triggerSchedule on missing id returns error", async () => {
    const r = await schedulerService.triggerSchedule("nope");
    expect((r as any).error).toBe("schedule not found");
  });

  it("nextRunAt is recomputed after fire", async () => {
    const created = schedulerService.createSchedule({
      name: "nx",
      every: "5m",
      action: { type: "command", command: ["echo", "x"] },
      enabled: false,
    });
    const before = Date.now();
    const r = await schedulerService.triggerSchedule((created as any).id);
    const updated = schedulerStore.getSchedule((created as any).id);
    expect(updated.status.nextRunAt).toBeTruthy();
    const next = new Date(updated.status.nextRunAt).getTime();
    // Should be ~5 min from finishedAt (within a generous window)
    expect(next).toBeGreaterThan(before);
    expect(next).toBeLessThan(before + 6 * 60_000);
  });
});

describe("scheduler service — inflight TTL sweep", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-sched-ttl-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    // The inflight Map is module-level; drain leftovers from prior tests.
    for (const e of (schedulerService as any)._getInflightAgentsForTest()) {
      (schedulerService as any)._trackAgentForTest(e.agentId, e.scheduleId, 0);
    }
    schedulerService.sweepInflightAgents();
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("sweepInflightAgents prunes entries older than TTL", () => {
    const TTL = 6 * 60 * 1000;
    const old = Date.now() - TTL - 1000;
    const fresh = Date.now() - 1000;

    (schedulerService as any)._trackAgentForTest("agent-old", "sched-1", old);
    (schedulerService as any)._trackAgentForTest("agent-fresh", "sched-1", fresh);

    const before = (schedulerService as any)._getInflightAgentsForTest();
    expect(before).toHaveLength(2);

    const pruned = schedulerService.sweepInflightAgents();
    expect(pruned).toBe(1);

    const after = (schedulerService as any)._getInflightAgentsForTest();
    expect(after).toHaveLength(1);
    expect(after[0].agentId).toBe("agent-fresh");
  });

  it("sweepInflightAgents leaves all entries when none are expired", () => {
    const fresh = Date.now() - 1000;
    (schedulerService as any)._trackAgentForTest("a", "s", fresh);
    (schedulerService as any)._trackAgentForTest("b", "s", fresh);
    expect(schedulerService.sweepInflightAgents()).toBe(0);
    expect((schedulerService as any)._getInflightAgentsForTest()).toHaveLength(2);
  });
});
