// Verifies the `workflow` scheduler action runs the saved workflow skill
// via the workflow engine. Previously stubbed as `{status:"skipped"}`.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("scheduler workflow action", () => {
  let svc: any;
  let skillStore: any;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sched-wf-"));
    // Pre-create .zana/ so resolveProjectDir anchors here and doesn't walk
    // up to /tmp/.zana/ (the real workspace), which is sandbox-blocked.
    mkdirSync(join(tmpDir, ".zana"), { recursive: true });
    const ws = await import("@zana-ai/core/src/project/workspace-context.ts");
    ws.init(tmpDir);
    // The workflow engine reaches workspace-context via @zana-ai/core's facade.
    // Make sure it's the same singleton by reading via the same path.
    const coreFacade = await import("@zana-ai/core");
    coreFacade.project.workspaceContext.init(tmpDir);
    svc = await import("@zana-ai/work/src/scheduling/service.ts");
    skillStore = await import("@zana-ai/extras/src/settings/skill-store.ts");
  });

  it("runs a workflow skill via the engine and returns success", async () => {
    const skill = skillStore.saveSkill({
      id: "wf-smoke",
      name: "wf smoke",
      type: "workflow",
      enabled: true,
      steps: [
        { action: "wait", durationMs: 50 },
        { action: "wait", durationMs: 50 },
      ],
    });
    expect(skill.id).toBe("wf-smoke");

    const sched = svc.createSchedule({
      name: "wf-runner",
      intervalMs: 0,
      enabled: false,
      action: { type: "workflow", skillId: "wf-smoke" },
    });

    const out = await svc.triggerSchedule(sched.id);
    expect(out.result.status).toBe("success");
    expect(out.result.runId).toBeTruthy();
    expect(out.result.steps).toBe(2);
  });

  it("returns error when skillId is missing", async () => {
    const sched = svc.createSchedule({
      name: "wf-no-id",
      intervalMs: 0,
      enabled: false,
      action: { type: "workflow" },
    });
    const out = await svc.triggerSchedule(sched.id);
    expect(out.result.status).toBe("error");
    expect(out.result.error).toMatch(/skillId/);
  });

  it("returns error when skill is not found", async () => {
    const sched = svc.createSchedule({
      name: "wf-missing",
      intervalMs: 0,
      enabled: false,
      action: { type: "workflow", skillId: "does-not-exist" },
    });
    const out = await svc.triggerSchedule(sched.id);
    expect(out.result.status).toBe("error");
    expect(out.result.error).toMatch(/not found/);
  });

  it("returns error when skill is not a workflow", async () => {
    skillStore.saveSkill({
      id: "non-wf",
      name: "instruction skill",
      type: "instruction",
      enabled: true,
      content: "just a doc, no steps",
    });
    const sched = svc.createSchedule({
      name: "wrong-type",
      intervalMs: 0,
      enabled: false,
      action: { type: "workflow", skillId: "non-wf" },
    });
    const out = await svc.triggerSchedule(sched.id);
    expect(out.result.status).toBe("error");
    expect(out.result.error).toMatch(/not a workflow/);
  });
});
