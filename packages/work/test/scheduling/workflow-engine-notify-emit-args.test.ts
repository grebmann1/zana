// The existing notify-step tests assert only the step *result*
// (`{ emitted: <eventType> }`). They never assert the actual side effect:
// what payload / tags the "notify" action forwards to
// `core.events.service.emit(type, payload, tags)`.
//
// workflow-engine.ts (notify branch):
//   const payload = step.payload ? interpolatePrompt(JSON.stringify(step.payload), context) : "{}";
//   try { parsedPayload = JSON.parse(payload); } catch { parsedPayload = { raw: payload }; }
//   eventBusService.emit(step.eventType || "workflow:notification", parsedPayload, step.tags || []);
//
// These tests pin the observable emit arguments:
//   1. payload templates are interpolated from triggerContext before emit
//   2. step.tags are forwarded verbatim (and default to [] when omitted)
//   3. an omitted payload emits an empty object
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import { executeWorkflow } from "@zana-ai/work/src/scheduling/workflow-engine.ts";

const TEST_WS = path.join(os.tmpdir(), `zana-test-wfe-notify-emit-${process.pid}`);

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

describe("executeWorkflow — notify step emit arguments", () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetWorkspace();
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
    // _core() inside workflow-engine resolves to the bare "@zana-ai/core"
    // module — the same instance as this `core` import — so spying here
    // intercepts the engine's emit call.
    emitSpy = vi.spyOn((core as any).events.service, "emit").mockImplementation(() => {});
  });

  afterEach(() => {
    emitSpy.mockRestore();
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("interpolates payload templates from triggerContext and forwards tags", async () => {
    const run = await executeWorkflow(
      {
        id: "notify-emit-args",
        name: "Notify Emit Args",
        steps: [
          {
            action: "notify",
            eventType: "ticket:flagged",
            payload: { ticketId: "{{ticket.id}}", note: "static" },
            tags: ["urgent", "qa"],
          },
        ],
      },
      { ticket: { id: "T-42" } },
    );

    expect(run.status).toBe("completed");
    expect(emitSpy).toHaveBeenCalledTimes(1);
    const [type, payload, tags] = emitSpy.mock.calls[0];
    expect(type).toBe("ticket:flagged");
    // {{ticket.id}} resolved from triggerContext; static text preserved.
    expect(payload).toEqual({ ticketId: "T-42", note: "static" });
    // Tags forwarded verbatim as the third argument.
    expect(tags).toEqual(["urgent", "qa"]);
  });

  it("emits an empty object and default [] tags when payload/tags are omitted", async () => {
    await executeWorkflow({
      id: "notify-emit-defaults",
      name: "Notify Emit Defaults",
      steps: [{ action: "notify", eventType: "bare:event" }],
    });

    expect(emitSpy).toHaveBeenCalledTimes(1);
    const [type, payload, tags] = emitSpy.mock.calls[0];
    expect(type).toBe("bare:event");
    expect(payload).toEqual({});
    expect(tags).toEqual([]);
  });
});
