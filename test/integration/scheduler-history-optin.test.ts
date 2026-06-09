// Verifies the opt-in `history` block: when disabled the run-history file
// is never written; when retain is set, history is capped to that count.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("scheduler — opt-in history", () => {
  let svc: any;
  let store: any;
  let dir: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sched-hist-"));
    // Pre-create .zana/ so resolveProjectDir anchors here and doesn't walk
    // up to /tmp/.zana/ (the real workspace), which is sandbox-blocked.
    mkdirSync(join(tmpDir, ".zana"), { recursive: true });
    const ws = await import("@zana-ai/core/src/project/workspace-context.ts");
    ws.init(tmpDir);
    // Also init the dist instance — service/store reach workspaceContext via
    // require("@zana-ai/core") which resolves to dist; otherwise the
    // tenant-isolation gate refuses the write.
    const core = await import("@zana-ai/core");
    try { (core as any).project.workspaceContext.init(tmpDir); } catch {}
    svc = await import("@zana-ai/work/src/scheduling/service.ts");
    store = await import("@zana-ai/work/src/scheduling/store.ts");
    // worker-7 retired cfg.SCHEDULER_DIR; resolve via workspaceContext.
    dir = ws.getProjectPaths().schedulerDir;
  });

  afterEach(async () => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try {
      const ws = await import("@zana-ai/core/src/project/workspace-context.ts");
      (ws as any)._resetForTesting?.();
    } catch {}
    try {
      const core = await import("@zana-ai/core");
      (core as any).project.workspaceContext._resetForTesting?.();
    } catch {}
  });

  it("default: history file is written (back-compat)", async () => {
    const sched = svc.createSchedule({
      name: "default-hist",
      intervalMs: 0,
      enabled: false,
      action: { type: "command", command: ["echo", "hi"] },
    });
    await svc.triggerSchedule(sched.id);
    const histPath = join(dir, `${sched.id}.history.json`);
    expect(existsSync(histPath)).toBe(true);
    const arr = JSON.parse(readFileSync(histPath, "utf8"));
    expect(arr.length).toBe(1);
    expect(arr[0].status).toBe("success");
  });

  it("history.enabled=false: no file written, getRunHistory returns empty", async () => {
    const sched = svc.createSchedule({
      name: "no-hist",
      intervalMs: 0,
      enabled: false,
      action: { type: "command", command: ["echo", "hi"] },
      history: { enabled: false },
    });
    await svc.triggerSchedule(sched.id);
    expect(existsSync(join(dir, `${sched.id}.history.json`))).toBe(false);
    expect(store.getRunHistory(sched.id)).toEqual([]);
  });

  it("history.retain caps the kept entries", async () => {
    const sched = svc.createSchedule({
      name: "ring-hist",
      intervalMs: 0,
      enabled: false,
      action: { type: "command", command: ["echo", "hi"] },
      history: { enabled: true, retain: 2 },
    });
    await svc.triggerSchedule(sched.id);
    await svc.triggerSchedule(sched.id);
    await svc.triggerSchedule(sched.id);
    const arr = JSON.parse(readFileSync(join(dir, `${sched.id}.history.json`), "utf8"));
    expect(arr.length).toBe(2);
  });

  it("validateSchedule rejects bad history config", async () => {
    const schema = await import("@zana-ai/work/src/scheduling/schema.ts");
    const issues = schema.validateSchedule({
      id: "x",
      name: "x",
      schedule: { every: "1m" },
      action: { type: "command", command: ["echo"] },
      history: { enabled: "yes", retain: -3 },
    });
    const errs = issues.filter((i: any) => i.level === "error").map((i: any) => i.field);
    expect(errs).toContain("history.enabled");
    expect(errs).toContain("history.retain");
  });

  it("validateSchedule warns on unknown top-level field", async () => {
    const schema = await import("@zana-ai/work/src/scheduling/schema.ts");
    const issues = schema.validateSchedule({
      id: "x",
      name: "x",
      schedule: { every: "1m" },
      action: { type: "command", command: ["echo"] },
      banana: 42,
    });
    const warnFields = issues.filter((i: any) => i.level === "warning").map((i: any) => i.field);
    expect(warnFields).toContain("banana");
  });
});
