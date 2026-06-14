// When the consecutive-failure breaker trips, triggerSchedule must call
// stopTrigger(id) so the live cron/interval stops re-firing — otherwise an
// auto-disabled schedule keeps burning fires on its timer. The existing
// breaker suite asserts enabled=false + autoDisabledReason but never checks
// that the ACTIVE trigger is actually torn down. This covers that invariant
// via the _getActiveTriggers() test helper. See service.ts ~L517-525.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";

describe("scheduler service — breaker tears down the active trigger", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-svc-breaker-stop-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    schedulerService.stopAll();
  });

  afterEach(() => {
    schedulerService.stopAll();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("removes the active trigger once the breaker auto-disables the schedule", async () => {
    // Enabled schedule with an action that errors on every fire (mcp_tool with
    // no toolName). createSchedule arms an interval trigger because enabled.
    const created: any = schedulerService.createSchedule({
      name: "perma-fail-stop",
      every: "5m",
      action: { type: "mcp_tool" } as any, // missing toolName → error every fire
      enabled: true,
    });
    const id: string = created.id;

    // Trigger is live before the breaker trips.
    expect(
      schedulerService._getActiveTriggers().some((t: any) => t.scheduleId === id),
    ).toBe(true);

    // Fire to the cap (3 consecutive errors).
    await schedulerService.triggerSchedule(id);
    await schedulerService.triggerSchedule(id);
    const tripped: any = await schedulerService.triggerSchedule(id);

    // Breaker engaged...
    expect(tripped.schedule.enabled).toBe(false);
    expect(tripped.schedule.status.consecutiveErrors).toBe(3);

    // ...and the active trigger was torn down so it can't re-fire on its timer.
    expect(
      schedulerService._getActiveTriggers().some((t: any) => t.scheduleId === id),
    ).toBe(false);
  });
});
