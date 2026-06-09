// Verifies the `mcp_tool` scheduler action dispatches via the orchestrator
// (zana_X → orchestrator action X). Previously stubbed as `{status:"skipped"}`.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("scheduler mcp_tool action", () => {
  let svc: any;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sched-mcp-"));
    // Pre-create .zana/ so resolveProjectDir anchors here and doesn't walk
    // up to /tmp/.zana/ (the real workspace), which is sandbox-blocked.
    mkdirSync(join(tmpDir, ".zana"), { recursive: true });
    const ws = await import("@zana-ai/core/src/project/workspace-context.ts");
    ws.init(tmpDir);
    // Dual-init the dist instance — store.ts requires @zana-ai/core → dist.
    const core = await import("@zana-ai/core");
    const wcDist: any = (core as any).project?.workspaceContext;
    if (wcDist && typeof wcDist.init === "function") wcDist.init(tmpDir);
    svc = await import("@zana-ai/work/src/scheduling/service.ts");
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
