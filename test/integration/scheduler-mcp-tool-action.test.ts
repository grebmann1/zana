// Verifies the `mcp_tool` scheduler action dispatches via the orchestrator
// (zana_X → orchestrator action X). Previously stubbed as `{status:"skipped"}`.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("scheduler mcp_tool action", () => {
  let svc: any;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sched-mcp-"));
    const ws = await import("@zana/core/src/project/workspace-context.ts");
    ws.init(tmpDir);
    svc = await import("@zana/work/src/scheduling/service.ts");
  });

  it("rejects missing toolName", async () => {
    const sched = svc.createSchedule({
      name: "no-tool",
      intervalMs: 0,
      enabled: false,
      action: { type: "mcp_tool" },
    });
    const out = await svc.triggerSchedule(sched.id);
    expect(out.result.status).toBe("error");
    expect(out.result.error).toMatch(/toolName/);
  });

  it("rejects non-zana toolName", async () => {
    const sched = svc.createSchedule({
      name: "bad-prefix",
      intervalMs: 0,
      enabled: false,
      action: { type: "mcp_tool", toolName: "fs_read" },
    });
    const out = await svc.triggerSchedule(sched.id);
    expect(out.result.status).toBe("error");
    expect(out.result.error).toMatch(/zana_/);
  });

  it("returns error for unknown tool", async () => {
    const sched = svc.createSchedule({
      name: "unknown-tool",
      intervalMs: 0,
      enabled: false,
      action: { type: "mcp_tool", toolName: "zana_does_not_exist", toolArgs: {} },
    });
    const out = await svc.triggerSchedule(sched.id);
    expect(out.result.status).toBe("error");
    expect(out.result.error).toMatch(/unknown action/);
  });

  it("invokes a known tool (zana_list_profiles) and returns its result", async () => {
    const sched = svc.createSchedule({
      name: "list-profiles",
      intervalMs: 0,
      enabled: false,
      action: { type: "mcp_tool", toolName: "zana_list_profiles", toolArgs: {} },
    });
    const out = await svc.triggerSchedule(sched.id);
    expect(out.result.status).toBe("success");
    // list_profiles returns an array of profile summaries.
    expect(Array.isArray(out.result.data)).toBe(true);
  });
});
