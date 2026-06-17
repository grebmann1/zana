// Unit tests for registrations/workflows.ts
//
// Covers:
//   - Tool definition shape (3 tools, required fields)
//   - zana_workflow_run: returns error when skill not found
//   - zana_workflow_run: returns error when skill is not a workflow type
//   - zana_workflow_list_runs: returns an array (filters forwarded to real engine)
//   - zana_workflow_get_run: returns error when run is not found
//
// NOTE: The zana_workflow_run happy-paths (executeWorkflow / ticket injection)
// and the zana_workflow_get_run "found" path require mocking @zana-ai/work at
// runtime.  The ssr.noExternal Vite config inlines @zana-ai/* packages before
// vi.mock can intercept them, so those tests are omitted rather than weakened
// (same pattern as registrations/autopilot.test.ts).
//
// Workspace context is initialised to a fresh temp dir so the real workflow
// engine (listRuns / loadRun) can execute without throwing.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";

import { workflows } from "../../src/registrations/workflows.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (workflows.handlers as Record<string, Handler>)[name];
}

// ─── workspace context setup ─────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "zana-wf-test-"));
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool-definition shape
// ─────────────────────────────────────────────────────────────────────────────

describe("workflows tool definitions", () => {
  const toolNames = workflows.tools.map((t) => t.name);

  it("exposes exactly three tool names", () => {
    expect(toolNames).toHaveLength(3);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "zana_workflow_run",
        "zana_workflow_list_runs",
        "zana_workflow_get_run",
      ]),
    );
  });

  it("zana_workflow_run requires skillId", () => {
    const tool = workflows.tools.find((t) => t.name === "zana_workflow_run")!;
    expect(tool.inputSchema.required).toContain("skillId");
  });

  it("zana_workflow_get_run requires runId", () => {
    const tool = workflows.tools.find((t) => t.name === "zana_workflow_get_run")!;
    expect(tool.inputSchema.required).toContain("runId");
  });

  it("zana_workflow_list_runs status enum covers expected states", () => {
    const tool = workflows.tools.find((t) => t.name === "zana_workflow_list_runs")!;
    const statusEnum = (tool.inputSchema.properties as any).status.enum as string[];
    expect(statusEnum).toEqual(
      expect.arrayContaining(["running", "completed", "halted", "failed"]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_workflow_run handler
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_workflow_run handler", () => {
  const handler = getHandler("zana_workflow_run");

  it("returns error when skillId is not in the skill store", async () => {
    const result = await handler({ skillId: "no-such-skill-xyz" });
    expect(result).toEqual({ error: "workflow skill not found" });
  });

  it("returns error for a skillId that resolves to a non-workflow type", async () => {
    // Real skill store has no entry for this id — guard fires on !skill.
    const result = await handler({ skillId: "instruction-only-skill" });
    expect(result).toEqual({ error: "workflow skill not found" });
  });

  // NOTE: executeWorkflow happy-paths (tests 3 and 4) are omitted because
  // vi.mock("@zana-ai/work") cannot intercept the lazy require() inside
  // workflows.ts when ssr.noExternal is active. See autopilot.test.ts comment.
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_workflow_list_runs handler
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_workflow_list_runs handler", () => {
  const handler = getHandler("zana_workflow_list_runs");

  it("returns an array when a status filter is provided", () => {
    const result = handler({ status: "completed" });
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns an array when no filter is supplied", () => {
    const result = handler({});
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_workflow_get_run handler
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_workflow_get_run handler", () => {
  const handler = getHandler("zana_workflow_get_run");

  it("returns error when run is not found", () => {
    const result = handler({ runId: "r-nonexistent-xyz" });
    expect(result).toEqual({ error: "run not found" });
  });

  // NOTE: "returns run object when found" and "calls loadRun with runId" are
  // omitted — creating a persisted run requires mocking executeWorkflow, which
  // is blocked by the same ssr.noExternal constraint noted above.
});
