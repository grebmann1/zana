// Interaction between the liveness-gated overlap skip and the consecutive-
// failure circuit breaker in triggerSchedule.
//
// The overlap-skip branch returns early (before the breaker bookkeeping), so a
// fire that is skipped because a prior agent is still live must leave the
// error streak exactly as it was: a skip is NOT an error (so it must not climb
// toward the auto-disable cap) and NOT a success (so it must not reset an
// existing streak). Each path is covered on its own elsewhere; this pins their
// intersection.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";

describe("scheduler service — overlap skip leaves the failure-breaker streak untouched", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-svc-breaker-skip-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    schedulerService.stopAll();
  });

  afterEach(() => {
    schedulerService.stopAll();
    schedulerService._setAgentStateResolverForTest(null); // reset override
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("a skipped fire neither advances nor resets the consecutive-error streak", async () => {
    // mcp_tool with no toolName errors on every fire that actually runs.
    const id = (schedulerService.createSchedule({
      name: "skip-vs-breaker",
      every: "5m",
      action: { type: "mcp_tool" } as any,
      enabled: true,
    }) as any).id as string;

    // Build a partial error streak (2 of the cap of 3), still enabled.
    await schedulerService.triggerSchedule(id);
    const r2: any = await schedulerService.triggerSchedule(id);
    expect(r2.result.status).toBe("error");
    expect(r2.schedule.status.consecutiveErrors).toBe(2);
    expect(r2.schedule.enabled).toBe(true);

    // Now a prior agent for THIS schedule is still live → the next fire skips
    // before executeAction (and before the breaker bookkeeping) runs.
    schedulerService._trackAgentForTest("agent-live", id);
    schedulerService._setAgentStateResolverForTest((aid) =>
      aid === "agent-live" ? "active" : undefined,
    );

    const skipped: any = await schedulerService.triggerSchedule(id);
    expect(skipped.skipped).toBe(true);
    expect(skipped.result.status).toBe("skipped");

    // Streak is untouched: not incremented to 3 (so NOT auto-disabled) and not
    // reset to 0 (a skip is not a success).
    expect(skipped.schedule.status.consecutiveErrors).toBe(2);
    expect(skipped.schedule.enabled).toBe(true);
    expect(skipped.schedule.status.autoDisabledReason ?? null).toBeNull();
    expect(skipped.schedule.status.lastRunResult).toBe("skipped");
  });
});
