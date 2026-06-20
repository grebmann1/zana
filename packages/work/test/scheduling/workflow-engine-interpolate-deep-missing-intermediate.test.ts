// Tests the optional-chaining guard inside `interpolatePrompt`'s dot-path loop
// (workflow-engine.ts ~line 68): `val = val?.[p]`.
//
// The existing interpolate-prompt test covers a ONE-level miss
// ({{ticket.missing}}, where `ticket` exists). It never traverses a token whose
// INTERMEDIATE segment is absent (e.g. {{ticket.foo.bar}} where `ticket.foo` is
// undefined). That deep case is the only thing that exercises `?.` on a
// mid-loop `undefined`: a third hop of `undefined?.["bar"]`. Without the
// optional chaining this would throw "Cannot read properties of undefined
// (reading 'bar')" and fail the whole step — so this pins that the engine
// degrades a deep dangling token to "" instead of crashing.
//
// Exercised privately through the notify step's payload-interpolation branch,
// matching the harness used by workflow-engine-interpolate-prompt.test.ts.
// Deterministic: isolated tmp workspace, no real clock/network/Claude.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import { executeWorkflow } from "@zana-ai/work/src/scheduling/workflow-engine.ts";

const TEST_WS = path.join(os.tmpdir(), `zana-test-wfe-interp-deep-${process.pid}`);
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

describe("interpolatePrompt — deep token through a missing intermediate key", () => {
  beforeEach(() => {
    resetWorkspace();
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("{{ticket.foo.bar}} with `foo` absent renders empty (no throw on the undefined hop)", async () => {
    // `ticket` exists but `ticket.foo` is undefined, so the loop reaches
    // `undefined?.["bar"]` on the final segment — the `?.` must short-circuit
    // to undefined → "" rather than throwing.
    const run = await executeWorkflow(
      { id: "interp-deep-miss", name: "Interp Deep Miss", steps: [
        { action: "notify", eventType: "test:deep-miss", payload: { val: "{{ticket.foo.bar}}" } },
      ] },
      { ticket: { status: "open" } },
    );
    expect(run.status).toBe("completed");
    expect(run.steps[0].result).toEqual({ emitted: "test:deep-miss" });
    expect(run.steps[0].error).toBeUndefined();
  });
});
