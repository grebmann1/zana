// Tests for the consecutive-failure circuit breaker in triggerSchedule.
//
// A schedule whose action errors every fire (here: an mcp_tool action with no
// toolName, which executeAction turns into a deterministic error result) must
// auto-disable after CONSEC_ERROR_CAP (3) consecutive errors. A success resets
// the streak; manually re-enabling clears the breaker state.
//
// Ported from claude-unleashed's boot-error breaker — see
// reviews/claude-unleashed-incorporation.md §2a.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";

describe("scheduler service — consecutive-failure circuit breaker", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-svc-breaker-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    schedulerService.stopAll();
  });

  afterEach(() => {
    schedulerService.stopAll();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // A schedule whose action always errors (mcp_tool with no toolName).
  function makeErroringSchedule(name: string) {
    const created = schedulerService.createSchedule({
      name,
      every: "5m",
      action: { type: "mcp_tool" } as any, // missing toolName → error every fire
      enabled: true,
    });
    return (created as any).id as string;
  }

  it("auto-disables after 3 consecutive error fires", async () => {
    const id = makeErroringSchedule("perma-fail");

    // Fire 1 and 2: error, still enabled, streak climbs.
    for (const expected of [1, 2]) {
      const r: any = await schedulerService.triggerSchedule(id);
      expect(r.result.status).toBe("error");
      expect(r.schedule.enabled).toBe(true);
      expect(r.schedule.status.consecutiveErrors).toBe(expected);
      expect(r.schedule.status.autoDisabledReason ?? null).toBeNull();
    }

    // Fire 3: hits the cap → auto-disabled with a reason.
    const r3: any = await schedulerService.triggerSchedule(id);
    expect(r3.result.status).toBe("error");
    expect(r3.schedule.status.consecutiveErrors).toBe(3);
    expect(r3.schedule.enabled).toBe(false);
    expect(r3.schedule.status.autoDisabledReason).toMatch(/3 consecutive errors/i);

    // The persisted schedule reflects the disable.
    const reloaded: any = schedulerService.getSchedule?.(id) ?? null;
    if (reloaded) expect(reloaded.enabled).toBe(false);
  });

  it("a success resets the consecutive-error streak", async () => {
    const id = makeErroringSchedule("flaky");

    // Two errors.
    await schedulerService.triggerSchedule(id);
    let r: any = await schedulerService.triggerSchedule(id);
    expect(r.schedule.status.consecutiveErrors).toBe(2);

    // Flip the action to a succeeding one (a trivial command), then fire.
    const sched: any = schedulerService.getSchedule(id);
    sched.action = { type: "command", argv: ["echo", "ok"] };
    schedulerService.updateSchedule?.(id, { action: sched.action });

    r = await schedulerService.triggerSchedule(id);
    expect(r.result.status).toBe("success");
    expect(r.schedule.status.consecutiveErrors).toBe(0);
    expect(r.schedule.status.autoDisabledReason ?? null).toBeNull();
    expect(r.schedule.enabled).toBe(true);
  });

  it("manual re-enable clears the breaker state", async () => {
    const id = makeErroringSchedule("re-enable");
    // Trip the breaker.
    await schedulerService.triggerSchedule(id);
    await schedulerService.triggerSchedule(id);
    const tripped: any = await schedulerService.triggerSchedule(id);
    expect(tripped.schedule.enabled).toBe(false);

    const re: any = schedulerService.enableSchedule(id);
    expect(re.ok).toBe(true);
    expect(re.schedule.enabled).toBe(true);
    expect(re.schedule.status.consecutiveErrors).toBe(0);
    expect(re.schedule.status.autoDisabledReason ?? null).toBeNull();
  });
});
