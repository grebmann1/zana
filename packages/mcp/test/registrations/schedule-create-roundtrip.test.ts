/**
 * Regression for ticket da57c40d — zana_schedule_create must succeed for all
 * six action types via the real MCP create path, and the created schedule must
 * round-trip with its action.type preserved.
 *
 * Root cause (now fixed): the MCP boundary built `{ action, ...params }` where
 * `action` was the routing command ("schedule_create") but `params.action` was
 * the schedule's action object. The spread clobbered the command, the
 * orchestrator switch received the OBJECT, missed every case, and fell through
 * to `default: unknown action: ${action}` → "[object Object]". Schedules were
 * never created.
 *
 * Fix: callers route the command under the reserved `_action` key (see
 * mcp-server.ts callCore + handleOrchestratorCommand). This test exercises that
 * full path END-TO-END — unlike dispatch-schedule-create-action-collision.test.ts,
 * which mocks the scheduler service. Here the REAL scheduler service persists to
 * a temp workspace and the schedule is read back from disk, proving the action
 * object survives routing + persistence intact for every action type.
 *
 * Pre-fix, every create call below returns { error: "unknown action: [object
 * Object]" } and these assertions fail.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Import the real core facade (built dist): its lazy `require()`s of sibling
// packages only resolve against compiled .js — same rationale as manager.test.ts.
import * as core from "@zana-ai/core";
// The real MCP registration handlers (source) — the actual create path callers hit.
import { schedules } from "../../src/registrations/schedules.ts";

const agentManager: any = (core as any).agents.manager;
const workspaceContext: any = (core as any).project.workspaceContext;

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
const handler = (name: string): Handler => (schedules.handlers as Record<string, Handler>)[name];

let tmpWs: string;

// callCore reproduced EXACTLY as mcp-server.ts builds it post-fix: the routing
// command travels under the reserved `_action` key so a `params.action`
// (the schedule's action object) can never clobber it.
const callCore = (op: string, params: Record<string, unknown> = {}) =>
  agentManager.handleOrchestratorCommand({ _action: op, ...params }, () => tmpWs);

beforeAll(() => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "zana-sched-roundtrip-"));
  fs.mkdirSync(path.join(tmpWs, ".zana"), { recursive: true });
  workspaceContext.init(tmpWs);
});

afterAll(() => {
  try { workspaceContext._resetForTesting?.(); } catch {}
  try { fs.rmSync(tmpWs, { recursive: true, force: true }); } catch {}
});

// The six action types the scheduler accepts (schema.ts ACTION_TYPES).
const ACTION_FIXTURES: Array<{ label: string; action: Record<string, unknown> }> = [
  { label: "prompt", action: { type: "prompt", profileId: "test-writer", prompt: "scan for gaps" } },
  { label: "spawn-agent", action: { type: "spawn-agent", profileId: "test-writer", prompt: "scan for gaps" } },
  { label: "team", action: { type: "team", teamId: "team-1", prompt: "go" } },
  { label: "command", action: { type: "command", command: ["npm", "test"] } },
  { label: "workflow", action: { type: "workflow", skillId: "wf-1" } },
  { label: "mcp_tool", action: { type: "mcp_tool", toolName: "zana_list_profiles", toolArgs: {} } },
];

describe("zana_schedule_create — full MCP create path round-trips every action type", () => {
  for (const { label, action } of ACTION_FIXTURES) {
    it(`creates a "${label}" schedule and round-trips with action.type preserved`, async () => {
      // Manual-only (enabled:false) so no live cron/interval timers spin up;
      // `every` still makes it a complete schedule.
      const created: any = await handler("zana_schedule_create")(
        { name: `roundtrip-${label}`, action, every: "1h", enabled: false },
        { callCore },
      );

      // Pre-fix this was { error: "unknown action: [object Object]" }.
      expect(created.error).toBeUndefined();
      expect(typeof created.id).toBe("string");
      // The action object reached the service intact — not coerced to a string.
      expect(created.action).toEqual(action);
      expect(created.action.type).toBe(action.type);

      // Round-trip: read the persisted schedule back from disk via the get path.
      const fetched: any = await handler("zana_schedule_get")(
        { scheduleId: created.id },
        { callCore },
      );
      expect(fetched.schedule).toBeTruthy();
      expect(fetched.schedule.action.type).toBe(action.type);
      expect(fetched.schedule.action).toEqual(action);
    });
  }

  it("lists all six created schedules with their action types intact", async () => {
    const list: any = await handler("zana_schedule_list")({}, { callCore });
    expect(Array.isArray(list)).toBe(true);

    const byName = new Map<string, any>(
      list
        .filter((s: any) => typeof s?.name === "string" && s.name.startsWith("roundtrip-"))
        .map((s: any) => [s.name, s]),
    );

    for (const { label, action } of ACTION_FIXTURES) {
      const s = byName.get(`roundtrip-${label}`);
      expect(s, `schedule roundtrip-${label} should be listed`).toBeTruthy();
      expect(s.action.type).toBe(action.type);
    }
    expect(byName.size).toBe(ACTION_FIXTURES.length);
  });
});
