// Tests for the "notify" action branch in executeStep
// (workflow-engine.ts lines 173-179).
//
// The "notify" action is not exercised by any of the four existing
// workflow-engine test files. Observable invariants:
//   1. step.result === { emitted: "workflow:notification" } when eventType is omitted
//   2. step.result === { emitted: <eventType> } when a custom eventType is given
//   3. run reaches status="completed" and subsequent steps still execute
//   4. no crash when step.payload is omitted (the `? interpolatePrompt : "{}"` branch)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import { executeWorkflow } from "@zana-ai/work/src/scheduling/workflow-engine.ts";

const TEST_WS = path.join(
  os.tmpdir(),
  `zana-test-wfe-notify-${process.pid}`,
);

const wcDist: any = (core as any).project.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContext as any, wcDist]) {
    try { if (typeof wc._resetForTesting === "function") wc._resetForTesting(); } catch {}
  }
}
function initWorkspace(root: string) {
  for (const wc of [workspaceContext as any, wcDist]) {
    try { wc.init(root); } catch {}
  }
}

describe("executeWorkflow — notify step", () => {
  beforeEach(() => {
    resetWorkspace();
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("defaults event type to 'workflow:notification' when eventType is omitted", async () => {
    const run = await executeWorkflow({
      id: "notify-default",
      name: "Notify Default",
      steps: [{ action: "notify" }],
    });
    expect(run.status).toBe("completed");
    expect(run.steps[0].status).toBe("completed");
    expect(run.steps[0].result).toEqual({ emitted: "workflow:notification" });
  });

  it("uses step.eventType when provided", async () => {
    const run = await executeWorkflow({
      id: "notify-custom-event",
      name: "Notify Custom Event",
      steps: [{ action: "notify", eventType: "my:custom:event" }],
    });
    expect(run.steps[0].result).toEqual({ emitted: "my:custom:event" });
  });

  it("run continues to subsequent steps after a notify step", async () => {
    const run = await executeWorkflow({
      id: "notify-continues",
      name: "Notify Continues",
      steps: [
        { action: "notify", eventType: "test:event" },
        { action: "gate", condition: "true" },
      ],
    });
    expect(run.status).toBe("completed");
    expect(run.steps[0].result).toMatchObject({ emitted: "test:event" });
    expect(run.steps[1].status).toBe("completed");
  });

  it("does not crash when step.payload is omitted (uses '{}' default)", async () => {
    // The branch: `step.payload ? interpolatePrompt(...) : "{}"`
    // must produce a valid parseable JSON object, so eventBusService.emit
    // is called without throwing.
    const run = await executeWorkflow({
      id: "notify-no-payload",
      name: "Notify No Payload",
      steps: [{ action: "notify", eventType: "empty-payload-event" }],
    });
    expect(run.status).toBe("completed");
    expect(run.steps[0].result).toEqual({ emitted: "empty-payload-event" });
  });
});
