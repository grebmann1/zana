// Defensive branch of the liveness-gated overlap skip in triggerSchedule.
//
// findLiveInflightForSchedule resolves each inflight agent's state through the
// (overridable) agentStateResolver and wraps the call in try/catch: if the
// resolver THROWS (agent manager unreachable, require cycle mid-load, etc.) the
// agent is treated as NOT live, so the schedule still fires. A flaky/unreachable
// resolver must never deadlock a schedule on a stale inflight entry.
//
// Companion to service-overlap-skip.test.ts, which covers the active/terminated
// /different-schedule cases but not a throwing resolver.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";

describe("scheduler service — overlap skip with a throwing state resolver", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-svc-overlap-throw-"));
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

  it("treats an unresolvable (throwing) agent as not-live and fires the schedule", async () => {
    const id = (schedulerService.createSchedule({
      name: "resolver-throws",
      every: "5m",
      action: { type: "command", argv: ["echo", "fired-anyway"] } as any,
      enabled: true,
    }) as any).id as string;

    // A prior fire's agent is still tracked, but the resolver blows up when
    // asked for its state — must NOT block the next fire.
    schedulerService._trackAgentForTest("agent-unresolvable", id);
    schedulerService._setAgentStateResolverForTest(() => {
      throw new Error("agent manager unreachable");
    });

    const r: any = await schedulerService.triggerSchedule(id);

    expect(r.skipped).toBeUndefined();
    expect(r.result.status).toBe("success");
    expect(r.result.stdout).toMatch(/fired-anyway/);
    expect(r.result.detail).not.toBe("prev-run-still-active");
  });
});
