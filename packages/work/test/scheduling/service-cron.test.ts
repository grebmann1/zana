// Scheduler service — cron-trigger lifecycle tests.
//
// The main service.test.ts only exercises `every`/`intervalMs` schedules.
// This file fills the gap by verifying that a `cron`-expression schedule is
// correctly wired end-to-end: written to disk with the right structure,
// starts a "cron"-kind trigger (not "interval"), persists `nextRunAt` on
// start, and is properly disabled / deleted.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";
import * as schedulerStore from "@zana-ai/work/src/scheduling/store.ts";

describe("scheduler service — cron schedule lifecycle", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-svc-cron-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    schedulerService.stopAll();
  });

  afterEach(() => {
    schedulerService.stopAll();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("createSchedule with a cron expression writes YAML to disk", () => {
    const result = schedulerService.createSchedule({
      name: "hourly-cron",
      cron: "0 * * * *",
      action: { type: "command", command: ["echo", "tick"] },
      enabled: true,
    }) as any;

    expect(result.error).toBeUndefined();
    expect(result.id).toBeTruthy();

    const dir = join(tmpRoot, ".zana", "scheduler");
    const files = readdirSync(dir);
    expect(files.some((f: string) => f.endsWith(".yml"))).toBe(true);
  });

  it("createSchedule with cron starts a 'cron'-kind trigger", () => {
    const result = schedulerService.createSchedule({
      name: "cron-trigger-kind",
      cron: "0 2 * * *",
      action: { type: "command", command: ["echo", "daily"] },
      enabled: true,
    }) as any;

    expect(result.error).toBeUndefined();

    const active = (schedulerService as any)._getActiveTriggers();
    expect(active).toHaveLength(1);
    expect(active[0].kind).toBe("cron");
    // Confirm it is NOT classified as an interval trigger.
    expect(active[0].kind).not.toBe("interval");
  });

  it("createSchedule with cron persists schedule.cron in the stored record", () => {
    const result = schedulerService.createSchedule({
      name: "cron-persist",
      cron: "30 6 * * 1",
      action: { type: "command", command: ["echo", "weekly"] },
      enabled: true,
    }) as any;

    expect(result.error).toBeUndefined();

    const stored = schedulerStore.getSchedule(result.id);
    expect(stored).not.toBeNull();
    // The cron expression must be nested in the schedule block, not only
    // at the document root.
    expect(stored.schedule?.cron).toBe("30 6 * * 1");
  });

  it("createSchedule with cron populates nextRunAt after start", () => {
    const result = schedulerService.createSchedule({
      name: "cron-next-run",
      cron: "*/5 * * * *",
      action: { type: "command", command: ["echo", "frequent"] },
      enabled: true,
    }) as any;

    expect(result.error).toBeUndefined();

    const stored = schedulerStore.getSchedule(result.id);
    // startTrigger() calls computeNextRunAt and saves nextRunAt into the
    // status block — it should be a non-null ISO string in the future.
    const nextRun = stored?.status?.nextRunAt ?? stored?.nextRunAt;
    expect(typeof nextRun).toBe("string");
    expect(new Date(nextRun).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("disableSchedule stops a cron trigger", () => {
    const result = schedulerService.createSchedule({
      name: "cron-disable",
      cron: "0 * * * *",
      action: { type: "command", command: ["echo", "x"] },
      enabled: true,
    }) as any;

    expect(result.error).toBeUndefined();
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(1);

    const disabled = schedulerService.disableSchedule(result.id) as any;
    expect(disabled.ok).toBe(true);
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(0);

    const stored = schedulerStore.getSchedule(result.id);
    expect(stored.enabled).toBe(false);
  });

  it("deleteSchedule removes the cron trigger and the on-disk file", () => {
    const result = schedulerService.createSchedule({
      name: "cron-delete",
      cron: "0 0 * * *",
      action: { type: "command", command: ["echo", "midnight"] },
      enabled: true,
    }) as any;

    expect(result.error).toBeUndefined();

    schedulerService.deleteSchedule(result.id);

    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(0);
    expect(schedulerStore.getSchedule(result.id)).toBeNull();
  });

  it("createSchedule with an unparseable cron expression creates the schedule but starts no trigger", () => {
    // Schema validation only checks that a cron field is present — it does NOT
    // validate the expression syntax. pickBackend() calls cronBackend.validate()
    // which returns false for gibberish, so startTrigger() logs a warning and
    // returns early without registering a trigger. The schedule IS persisted to
    // disk (the caller might fix the expression via updateSchedule later).
    const result = schedulerService.createSchedule({
      name: "bad-cron",
      cron: "not-a-cron",
      action: { type: "command", command: ["echo", "x"] },
      enabled: true,
    }) as any;

    // Schedule object is returned (no top-level error).
    expect(result.error).toBeUndefined();
    expect(result.id).toBeTruthy();

    // No trigger should have been registered.
    expect((schedulerService as any)._getActiveTriggers()).toHaveLength(0);

    // But the record IS on disk.
    const stored = schedulerStore.getSchedule(result.id);
    expect(stored).not.toBeNull();
    expect(stored.schedule?.cron).toBe("not-a-cron");
  });
});
