// Tests for liveness-gated overlap skip in triggerSchedule.
//
// Reproduces the confirmed double-fire: a schedule whose prior agent is still
// running must NOT spawn another on the next fire — it records a "skipped"
// result instead. When the prior agent has terminated, the next fire proceeds
// normally.
//
// Ported from claude-unleashed's prev-run-still-active skip — see
// reviews/claude-unleashed-incorporation.md §2c.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";

describe("scheduler service — liveness-gated overlap skip", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-svc-overlap-"));
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

  it("skips the fire when a prior agent for the same schedule is still active", async () => {
    // A command schedule (so executeAction would normally succeed if it ran).
    const id = (schedulerService.createSchedule({
      name: "overlapping",
      every: "5m",
      action: { type: "command", argv: ["echo", "should-not-run"] } as any,
      enabled: true,
    }) as any).id as string;

    // Simulate a prior fire's agent still in flight + alive.
    schedulerService._trackAgentForTest("agent-live", id);
    schedulerService._setAgentStateResolverForTest((aid) =>
      aid === "agent-live" ? "active" : undefined,
    );

    const r: any = await schedulerService.triggerSchedule(id);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.result.status).toBe("skipped");
    expect(r.result.detail).toBe("prev-run-still-active");
    expect(r.result.blockedByAgentId).toBe("agent-live");
    expect(r.schedule.status.lastRunResult).toBe("skipped");
  });

  it("fires normally once the prior agent has terminated", async () => {
    const id = (schedulerService.createSchedule({
      name: "no-longer-overlapping",
      every: "5m",
      action: { type: "command", argv: ["echo", "ran-ok"] } as any,
      enabled: true,
    }) as any).id as string;

    schedulerService._trackAgentForTest("agent-done", id);
    // Resolver reports a terminal state → not live → fire proceeds.
    schedulerService._setAgentStateResolverForTest((aid) =>
      aid === "agent-done" ? "terminated" : undefined,
    );

    const r: any = await schedulerService.triggerSchedule(id);
    expect(r.skipped).toBeUndefined();
    expect(r.result.status).toBe("success");
    expect(r.result.stdout).toMatch(/ran-ok/);
  });

  it("does not skip on an inflight entry belonging to a DIFFERENT schedule", async () => {
    const id = (schedulerService.createSchedule({
      name: "mine",
      every: "5m",
      action: { type: "command", argv: ["echo", "mine-ran"] } as any,
      enabled: true,
    }) as any).id as string;

    // A live agent, but tracked under someone else's scheduleId.
    schedulerService._trackAgentForTest("agent-other", "some-other-schedule");
    schedulerService._setAgentStateResolverForTest(() => "active");

    const r: any = await schedulerService.triggerSchedule(id);
    expect(r.skipped).toBeUndefined();
    expect(r.result.status).toBe("success");
    expect(r.result.stdout).toMatch(/mine-ran/);
  });
});
