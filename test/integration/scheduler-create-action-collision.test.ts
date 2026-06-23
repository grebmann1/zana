// Regression: zana_schedule_create rejected every action with
// "unknown action: [object Object]" (ticket 9c1d1bf5).
//
// Root cause was a parameter-name collision on the key `action`. The MCP
// boundary (callCore) built `{ action, ...params }` where `action` was the
// routing command ("schedule_create") but `params.action` was the schedule's
// action object. The spread clobbered the command, so handleOrchestratorCommand's
// switch received the OBJECT, missed every case, and fell through to
// `default: unknown action: ${action}` → "[object Object]".
//
// The fix routes the command under the reserved `_action` key (which can't be
// clobbered by an `action` parameter). This test drives the REAL
// handleOrchestratorCommand exactly as callCore now does, for every action
// type, and asserts each schedule is created (no "unknown action" fall-through)
// with its action object preserved intact.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The six action types the scheduler accepts (schema.ts ACTION_TYPES). Each
// fixture is a minimally-valid action object; only `type` is checked at create
// time (the rest is validated at trigger time).
const ACTION_FIXTURES: Array<{ label: string; action: Record<string, unknown> }> = [
  { label: "prompt", action: { type: "prompt", profileId: "test-writer", prompt: "scan for gaps" } },
  { label: "spawn-agent", action: { type: "spawn-agent", profileId: "test-writer", prompt: "scan for gaps" } },
  { label: "team", action: { type: "team", teamId: "team-1", prompt: "go" } },
  { label: "command", action: { type: "command", command: ["npm", "test"] } },
  { label: "workflow", action: { type: "workflow", skillId: "wf-1" } },
  { label: "mcp_tool", action: { type: "mcp_tool", toolName: "zana_list_profiles", toolArgs: {} } },
];

describe("schedule_create — action-object routing (no parameter collision)", () => {
  let dispatch: (payload: Record<string, unknown>) => Promise<any>;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sched-create-"));
    // Pre-create .zana/ so the workspace anchors here (and doesn't walk up to a
    // sandbox-blocked /tmp/.zana). Mirrors scheduler-mcp-tool-action.test.ts.
    mkdirSync(join(tmpDir, ".zana"), { recursive: true });
    const ws = await import("@zana-ai/contracts");
    ws.init(tmpDir);
    const core = await import("@zana-ai/core");
    const wcDist: any = (core as any).project?.workspaceContext;
    if (wcDist && typeof wcDist.init === "function") wcDist.init(tmpDir);

    const handle = (core as any).agents.manager.handleOrchestratorCommand;
    // Build the payload exactly as callCore does post-fix: routing command under
    // the reserved `_action`, the schedule's `action` object as a sibling param.
    dispatch = (params) => handle({ _action: "schedule_create", ...params }, () => tmpDir);
  });

  for (const { label, action } of ACTION_FIXTURES) {
    it(`creates a schedule with a "${label}" action and preserves the action object`, async () => {
      const result = await dispatch({
        name: `sched-${label}`,
        every: "1h",
        enabled: false, // don't arm a real timer in the test
        action,
        ownerId: "agent",
        ownerName: "Agent",
      });

      // The bug surfaced as { error: "unknown action: [object Object]" }.
      expect(result).toBeTruthy();
      expect(result.error).toBeUndefined();

      // Success shape: createSchedule returns the persisted schedule with an id.
      expect(typeof result.id).toBe("string");
      expect(result.name).toBe(`sched-${label}`);

      // The action object must survive routing intact — not coerced to a string.
      expect(typeof result.action).toBe("object");
      expect(result.action).toEqual(action);
      expect(result.action.type).toBe(action.type);
    });
  }

  it("does not regress non-colliding commands routed via _action", async () => {
    // schedule_list carries no `action` param; it must still route correctly.
    const core = await import("@zana-ai/core");
    const handle = (core as any).agents.manager.handleOrchestratorCommand;
    const list = await handle({ _action: "schedule_list" }, () => process.env.HOME);
    expect(Array.isArray(list)).toBe(true);
  });

  it("still rejects a genuinely unknown command with a readable message", async () => {
    const core = await import("@zana-ai/core");
    const handle = (core as any).agents.manager.handleOrchestratorCommand;
    const out = await handle({ _action: "does_not_exist" }, () => process.env.HOME);
    expect(out.error).toBe("unknown action: does_not_exist");
  });
});
