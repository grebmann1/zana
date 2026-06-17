// Tests the `catch { parsedPayload = { raw: payload }; }` branch in the
// "notify" action of workflow-engine.ts (lines ~177-178).
//
// The branch fires when `interpolatePrompt(JSON.stringify(step.payload), ctx)`
// produces a string that is no longer valid JSON because a template
// variable's value contained characters (e.g. `"`) that break the
// surrounding JSON structure.
//
// Observable invariant: the workflow run still reaches status="completed"
// even when the payload cannot be re-parsed — the malformed string is
// wrapped in { raw: <string> } and emitted as-is so no exception propagates.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import { executeWorkflow } from "@zana-ai/work/src/scheduling/workflow-engine.ts";

const TEST_WS = path.join(
  os.tmpdir(),
  `zana-test-wfe-bad-payload-${process.pid}`,
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

describe("executeWorkflow — notify step with unparse-able interpolated payload", () => {
  beforeEach(() => {
    resetWorkspace();
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("run completes even when a template variable breaks the payload JSON", async () => {
    // step.payload = { message: "{{val}}" }
    // JSON.stringify → '{"message":"{{val}}"}'
    // After interpolation with val = 'has "quotes" inside':
    //   '{"message":"has "quotes" inside"}' — invalid JSON → catch branch fires
    const run = await executeWorkflow(
      {
        id: "notify-bad-payload",
        name: "Notify Bad Payload",
        steps: [
          {
            action: "notify",
            eventType: "test:bad-payload",
            payload: { message: "{{val}}" },
          },
        ],
      },
      { val: 'has "quotes" inside' },
    );

    expect(run.status).toBe("completed");
    expect(run.steps[0].status).toBe("completed");
    // The step still records the emitted event name — it did not throw.
    expect(run.steps[0].result).toEqual({ emitted: "test:bad-payload" });
  });

  it("subsequent steps continue executing after a bad-payload notify step", async () => {
    const run = await executeWorkflow(
      {
        id: "notify-bad-payload-continues",
        name: "Notify Bad Payload Continues",
        steps: [
          {
            action: "notify",
            eventType: "first:event",
            payload: { msg: "{{broken}}" },
          },
          { action: "gate", condition: "true" },
        ],
      },
      { broken: 'x"y' }, // quote inside → JSON becomes invalid after substitution
    );

    expect(run.status).toBe("completed");
    expect(run.steps[0].result).toMatchObject({ emitted: "first:event" });
    expect(run.steps[1].status).toBe("completed");
  });
});
