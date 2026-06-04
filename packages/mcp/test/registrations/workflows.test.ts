// Unit tests for registrations/workflows.ts
//
// Covers:
//   - Tool definition shape (3 tools, required fields)
//   - zana_workflow_run: returns error when skill not found
//   - zana_workflow_run: returns error when skill is not a workflow type
//   - zana_workflow_run: calls executeWorkflow with skill and empty context
//   - zana_workflow_run: injects ticket into context when ticketId is supplied
//   - zana_workflow_list_runs: forwards optional status filter to listRuns
//   - zana_workflow_get_run: returns error when run not found
//   - zana_workflow_get_run: returns run object when found
//
// No daemon, no network, no file I/O. All module dependencies are faked via
// vi.mock so the lazy require() calls inside the handlers are intercepted.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── module mocks (must be before the import under test) ────────────────────

const mockExecuteWorkflow = vi.fn();
const mockListRuns = vi.fn();
const mockLoadRun = vi.fn();
const mockGetTicket = vi.fn();
const mockGetSkill = vi.fn();

vi.mock("@zana-ai/work", () => ({
  scheduling: {
    workflowEngine: {
      executeWorkflow: (...args: unknown[]) => mockExecuteWorkflow(...args),
      listRuns: (...args: unknown[]) => mockListRuns(...args),
      loadRun: (...args: unknown[]) => mockLoadRun(...args),
    },
  },
  tickets: {
    service: {
      getTicket: (...args: unknown[]) => mockGetTicket(...args),
    },
  },
}));

vi.mock("@zana-ai/extras", () => ({
  settings: {
    skillStore: {
      getSkill: (...args: unknown[]) => mockGetSkill(...args),
    },
  },
}));

import { workflows } from "../../src/registrations/workflows.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (workflows.handlers as Record<string, Handler>)[name];
}

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

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns error when skill is not found", async () => {
    mockGetSkill.mockReturnValue(null);
    const result = await handler({ skillId: "missing-skill" });
    expect(result).toEqual({ error: "workflow skill not found" });
  });

  it("returns error when skill exists but is not type workflow", async () => {
    mockGetSkill.mockReturnValue({ id: "s1", type: "instruction", content: "" });
    const result = await handler({ skillId: "s1" });
    expect(result).toEqual({ error: "workflow skill not found" });
  });

  it("calls executeWorkflow with the skill and empty context when no ticketId", async () => {
    const skill = { id: "wf-1", type: "workflow", steps: [] };
    mockGetSkill.mockReturnValue(skill);
    mockExecuteWorkflow.mockResolvedValue({ runId: "r-1", status: "completed" });

    const result = await handler({ skillId: "wf-1" });

    expect(mockExecuteWorkflow).toHaveBeenCalledOnce();
    expect(mockExecuteWorkflow).toHaveBeenCalledWith(skill, {});
    expect(result).toEqual({ runId: "r-1", status: "completed" });
  });

  it("injects ticket into context when ticketId is provided", async () => {
    const skill = { id: "wf-2", type: "workflow", steps: [] };
    const ticket = { id: "T-10", title: "Implement feature", status: "in-progress" };
    mockGetSkill.mockReturnValue(skill);
    mockGetTicket.mockReturnValue(ticket);
    mockExecuteWorkflow.mockResolvedValue({ runId: "r-2", status: "running" });

    await handler({ skillId: "wf-2", ticketId: "T-10" });

    expect(mockGetTicket).toHaveBeenCalledWith("T-10");
    const [, context] = mockExecuteWorkflow.mock.calls[0];
    expect(context).toMatchObject({ ticket });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_workflow_list_runs handler
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_workflow_list_runs handler", () => {
  const handler = getHandler("zana_workflow_list_runs");

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("forwards status filter to listRuns", () => {
    const runs = [{ runId: "r-1", status: "completed" }];
    mockListRuns.mockReturnValue(runs);

    const result = handler({ status: "completed" });

    expect(mockListRuns).toHaveBeenCalledWith({ status: "completed" });
    expect(result).toBe(runs);
  });

  it("passes undefined status when no filter is supplied", () => {
    mockListRuns.mockReturnValue([]);
    handler({});
    expect(mockListRuns).toHaveBeenCalledWith({ status: undefined });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_workflow_get_run handler
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_workflow_get_run handler", () => {
  const handler = getHandler("zana_workflow_get_run");

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns error when run is not found", () => {
    mockLoadRun.mockReturnValue(null);
    const result = handler({ runId: "r-missing" });
    expect(result).toEqual({ error: "run not found" });
  });

  it("returns the run object when found", () => {
    const run = { runId: "r-3", status: "halted", steps: [] };
    mockLoadRun.mockReturnValue(run);
    const result = handler({ runId: "r-3" });
    expect(result).toBe(run);
  });

  it("calls loadRun with the provided runId", () => {
    mockLoadRun.mockReturnValue({ runId: "r-4" });
    handler({ runId: "r-4" });
    expect(mockLoadRun).toHaveBeenCalledWith("r-4");
  });
});
