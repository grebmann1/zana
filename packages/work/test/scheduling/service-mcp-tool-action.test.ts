// Tests for executeAction paths that are not exercised by service.test.ts:
//   • mcp_tool action — toolName missing or not starting with "zana_"
//   • command action — `argv` array alias (undocumented-but-tested code path at
//     service.ts line 315: `else if (Array.isArray(action.argv)) argv = action.argv`)
//
// The schema validator (validateSchedule) only checks that action.type is an
// allowed string — it does NOT inspect toolName, so mcp_tool schedules with
// invalid toolName pass createSchedule() and reach executeAction() on trigger.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";

describe("scheduler service — mcp_tool action validation in triggerSchedule", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-svc-mcptool-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    schedulerService.stopAll();
  });

  afterEach(() => {
    schedulerService.stopAll();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("mcp_tool action with no toolName returns an error result (not a throw)", async () => {
    // action.type = "mcp_tool" passes schema validation; the missing toolName is
    // only caught inside executeAction at service.ts line 346-347.
    const created = schedulerService.createSchedule({
      name: "missing-toolname",
      every: "5m",
      action: { type: "mcp_tool" } as any,
      enabled: false,
    });
    expect((created as any).error).toBeUndefined(); // schema accepts mcp_tool without toolName

    const r = await schedulerService.triggerSchedule((created as any).id);
    expect((r as any).ok).toBe(true);
    expect((r as any).result.status).toBe("error");
    expect((r as any).result.error).toMatch(/toolName/i);
  });

  it("mcp_tool action with toolName not starting with 'zana_' returns an error result", async () => {
    // service.ts line 349-350: toolName must start with "zana_".
    const created = schedulerService.createSchedule({
      name: "bad-toolname",
      every: "5m",
      action: { type: "mcp_tool", toolName: "other_tool" } as any,
      enabled: false,
    });
    const r = await schedulerService.triggerSchedule((created as any).id);
    expect((r as any).ok).toBe(true);
    expect((r as any).result.status).toBe("error");
    expect((r as any).result.error).toMatch(/zana_/i);
  });

  it("command action with argv alias fires like command array", async () => {
    // service.ts line 315: `else if (Array.isArray(action.argv)) argv = action.argv`
    // This code path is an undocumented alias that was never exercised by tests.
    const created = schedulerService.createSchedule({
      name: "argv-alias",
      every: "5m",
      action: { type: "command", argv: ["echo", "argv-ok"] } as any,
      enabled: false,
    });
    const r = await schedulerService.triggerSchedule((created as any).id);
    expect((r as any).ok).toBe(true);
    expect((r as any).result.status).toBe("success");
    expect((r as any).result.stdout).toMatch(/argv-ok/);
  });
});
