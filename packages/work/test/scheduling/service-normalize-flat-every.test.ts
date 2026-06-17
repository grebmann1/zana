// Tests for the normalizeSchedule code-path that lifts a root-level (flat)
// `every` field into the nested `schedule.every` block, and then projects it
// to `intervalMs` for pickBackend().
//
// packages/work/src/scheduling/service.ts lines 140-148:
//   if (s.every && !s.schedule.every) s.schedule.every = s.every;
//   if (s.schedule.every && s.schedule.intervalMs == null) {
//     s.schedule.intervalMs = everShorthandToMs(s.schedule.every);
//   }
//
// All existing service tests write schedules via createSchedule() or
// serializeYaml({ schedule: { every } }). Both produce a properly-nested
// schedule block, so the flat-field lift on line 140 is never exercised.
// This file covers the case where a user-authored YAML file places `every`
// at the document root (the flat legacy form).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";
import * as schedulerStore from "@zana-ai/work/src/scheduling/store.ts";

describe("normalizeSchedule — flat root-level `every` field", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-flat-every-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    schedulerService.stopAll();
  });

  afterEach(() => {
    schedulerService.stopAll();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  /** Write a raw YAML string directly to the scheduler directory. */
  function writeRawYaml(id: string, content: string) {
    schedulerStore.ensureDir();
    const dir = join(tmpRoot, ".zana", "scheduler");
    writeFileSync(join(dir, `${id}.yml`), content, "utf8");
  }

  it("loadFromDisk starts an interval trigger for a YAML file with flat root-level `every`", () => {
    // User-authored YAML: `every` at the document root, no nested `schedule:` block.
    // normalizeSchedule() must lift the flat field so pickBackend() can produce an
    // interval trigger instead of logging "no backend matched — skipping start".
    writeRawYaml("flat-every-load", [
      "id: flat-every-load",
      "name: Flat every schedule",
      "enabled: true",
      "every: 2m",
      "action:",
      "  type: command",
      "  command: [echo, tick]",
    ].join("\n"));

    const result = schedulerService.loadFromDisk();
    expect(result.started).toBe(1);
    expect(result.skipped).toBe(0);

    const triggers = (schedulerService as any)._getActiveTriggers();
    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("interval");
    expect(triggers[0].scheduleId).toBe("flat-every-load");
  });

  it("triggerSchedule fires successfully for a stored schedule with flat root-level `every`", async () => {
    // Write a flat-every schedule directly, bypassing createSchedule() so the
    // stored record genuinely has `every` at the document root rather than
    // nested under `schedule:`.
    writeRawYaml("flat-every-fire", [
      "id: flat-every-fire",
      "name: Flat fire",
      "enabled: true",
      "every: 5m",
      "action:",
      "  type: command",
      "  command: [echo, run]",
    ].join("\n"));

    const fire = await schedulerService.triggerSchedule("flat-every-fire") as any;
    expect(fire.ok).toBe(true);
    expect(fire.result.status).toBe("success");
    // runCount must have been incremented exactly once.
    const stored = schedulerStore.getSchedule("flat-every-fire");
    expect(stored?.status?.runCount).toBe(1);
  });
});
