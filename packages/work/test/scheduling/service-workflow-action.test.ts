// Tests for the `workflow` branch of executeAction, which is not exercised by
// any existing scheduling test (service.test.ts and the other service-*.test.ts
// files only cover command / mcp_tool / unknown action types).
//
// The schema validator (validateSchedule) only checks that action.type is an
// allowed string — it does NOT inspect skillId — so a workflow action with a
// missing/invalid skillId passes createSchedule() and the validation gate at
// service.ts ("workflow action requires skillId (string)") fires at trigger
// time. This case returns BEFORE touching the skill store or workflow engine,
// so it is fully deterministic: no real Claude, no skill lookup, no I/O.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";

describe("scheduler service — workflow action validation in triggerSchedule", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-svc-workflow-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    schedulerService.stopAll();
  });

  afterEach(() => {
    schedulerService.stopAll();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("workflow action with no skillId returns an error result (not a throw)", async () => {
    // action.type = "workflow" passes schema validation; the missing skillId is
    // only caught inside executeAction's workflow branch, which returns before
    // the skill store / workflow engine are ever consulted.
    const created = schedulerService.createSchedule({
      name: "missing-skillid",
      every: "5m",
      action: { type: "workflow" } as any,
      enabled: false,
    });
    expect((created as any).error).toBeUndefined(); // schema accepts workflow without skillId

    const r = await schedulerService.triggerSchedule((created as any).id);
    expect((r as any).ok).toBe(true);
    expect((r as any).result.status).toBe("error");
    expect((r as any).result.error).toMatch(/skillId/i);
    // The error is recorded against the schedule's run history / status too.
    expect((r as any).result.actionType).toBe("workflow");
    expect((r as any).schedule.status.lastRunResult).toMatch(/^error:/);
  });

  it("workflow action with a non-string skillId is rejected the same way", async () => {
    // The gate is `!action.skillId || typeof action.skillId !== "string"`, so a
    // numeric skillId must be rejected just like an absent one.
    const created = schedulerService.createSchedule({
      name: "numeric-skillid",
      every: "5m",
      action: { type: "workflow", skillId: 123 } as any,
      enabled: false,
    });
    const r = await schedulerService.triggerSchedule((created as any).id);
    expect((r as any).ok).toBe(true);
    expect((r as any).result.status).toBe("error");
    expect((r as any).result.error).toMatch(/skillId/i);
  });
});
