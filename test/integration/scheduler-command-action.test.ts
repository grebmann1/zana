// Verifies the `command` action only accepts argv arrays — string form
// (which would route through /bin/sh -c) is rejected as a safety measure.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("scheduler command action — shell injection guard", () => {
  let svc: any;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sched-cmd-"));
    const ws = await import("@zana-ai/core/src/project/workspace-context.ts");
    ws.init(tmpDir);
    svc = await import("@zana-ai/work/src/scheduling/service.ts");
  });

  it("rejects legacy string `command` — shell injection guard", async () => {
    const sched = svc.createSchedule({
      name: "string-cmd",
      intervalMs: 0,
      enabled: false,
      action: { type: "command", command: "echo hello; rm -rf /" },
    });
    const out = await svc.triggerSchedule(sched.id);
    expect(out.result.status).toBe("error");
    const reason = (out.result?.error || "").toLowerCase();
    expect(reason).toContain("array");
  });

  it("accepts argv array form and runs it without a shell", async () => {
    const sched = svc.createSchedule({
      name: "array-cmd",
      intervalMs: 0,
      enabled: false,
      action: { type: "command", command: ["echo", "hello"] },
    });
    const out = await svc.triggerSchedule(sched.id);
    expect(out.result.status).toBe("success");
    expect(out.result.stdout).toMatch(/hello/);
  });

  it("rejects non-array, non-string command (e.g. number)", async () => {
    const sched = svc.createSchedule({
      name: "bad-cmd",
      intervalMs: 0,
      enabled: false,
      action: { type: "command", command: 42 },
    });
    const out = await svc.triggerSchedule(sched.id);
    expect(out.result.status).toBe("error");
  });
});
