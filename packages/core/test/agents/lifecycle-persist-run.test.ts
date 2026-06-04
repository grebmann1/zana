// Unit tests for persistAgentRun() in agents/lifecycle.ts.
//
// Strategy: import via "@zana-ai/core" (resolves to the compiled dist) so that
// the lazy require("../project/workspace-context") inside persistAgentRun
// finds the compiled .js sibling — the Vite SSR runner cannot resolve relative
// require() calls inside raw .ts source files (see manager.test.ts for details).
// The dist workspace-context singleton is then init()-ed to a tmp directory.
//
// Behaviours under test:
//   1. Happy path — JSON file created at <runsDir>/<agentId>.json
//   2. childProcess field is stripped before serialisation
//   3. result longer than 100 KB is truncated with a note
//   4. terminatedAt and exitCode are added to the record
//   5. null exitCode is preserved as-is
//   6. Error during write is swallowed (console.warn, no throw)
//
// No real spawning, no PTY, no network — fully deterministic.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Import via the dist so all internal require() calls resolve cleanly.
import * as core from "@zana-ai/core";
const workspaceContext: any = (core as any).project.workspaceContext;
const { persistAgentRun } = (core as any).agents.manager as {
  persistAgentRun: (agent: any, exitCode: number | null) => void;
};

let tmpWs: string;
let runsDir: string;

beforeAll(() => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "zana-persist-run-test-"));
  fs.mkdirSync(path.join(tmpWs, ".zana"), { recursive: true });
  workspaceContext.init(tmpWs);
  runsDir = workspaceContext.getProjectPaths().runsDir;
});

afterAll(() => {
  try { (workspaceContext as any)._resetForTesting?.(); } catch {}
  try { fs.rmSync(tmpWs, { recursive: true, force: true }); } catch {}
});

/** Build a minimal fake agent object. */
function makeAgent(overrides: Record<string, any> = {}) {
  return {
    id: "test-agent-" + Math.random().toString(36).slice(2, 12),
    profileId: "profile-1",
    profileName: "Test Profile",
    state: "terminated",
    result: "Hello from agent",
    childProcess: { pid: 99, stdin: {}, stdout: {}, stderr: {} }, // should be stripped
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
describe("persistAgentRun — happy path", () => {
  it("creates a JSON file at <runsDir>/<agentId>.json", () => {
    const agent = makeAgent();
    persistAgentRun(agent, 0);

    const filePath = path.join(runsDir, `${agent.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(parsed.id).toBe(agent.id);
    expect(parsed.profileId).toBe("profile-1");
  });

  it("includes terminatedAt (ISO string) and exitCode in the record", () => {
    const agent = makeAgent();
    persistAgentRun(agent, 0);

    const parsed = JSON.parse(fs.readFileSync(path.join(runsDir, `${agent.id}.json`), "utf8"));

    expect(typeof parsed.terminatedAt).toBe("string");
    // terminatedAt must be a valid ISO date
    expect(new Date(parsed.terminatedAt).getTime()).toBeGreaterThan(0);
    expect(parsed.exitCode).toBe(0);
  });

  it("preserves null exitCode as null", () => {
    const agent = makeAgent();
    persistAgentRun(agent, null);

    const parsed = JSON.parse(fs.readFileSync(path.join(runsDir, `${agent.id}.json`), "utf8"));
    expect(parsed.exitCode).toBeNull();
  });

  it("preserves non-zero exitCode", () => {
    const agent = makeAgent({ state: "errored" });
    persistAgentRun(agent, 1);

    const parsed = JSON.parse(fs.readFileSync(path.join(runsDir, `${agent.id}.json`), "utf8"));
    expect(parsed.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("persistAgentRun — childProcess stripping", () => {
  it("omits childProcess from the written record", () => {
    const agent = makeAgent();
    persistAgentRun(agent, 0);

    const parsed = JSON.parse(fs.readFileSync(path.join(runsDir, `${agent.id}.json`), "utf8"));
    expect(parsed).not.toHaveProperty("childProcess");
  });
});

// ---------------------------------------------------------------------------
describe("persistAgentRun — result truncation", () => {
  const MAX_RESULT_BYTES = 100 * 1024; // 102 400 chars

  it("preserves short results unchanged", () => {
    const agent = makeAgent({ result: "short result" });
    persistAgentRun(agent, 0);

    const parsed = JSON.parse(fs.readFileSync(path.join(runsDir, `${agent.id}.json`), "utf8"));
    expect(parsed.result).toBe("short result");
  });

  it("truncates results exceeding 100 KB and appends a truncation note", () => {
    const longResult = "x".repeat(MAX_RESULT_BYTES + 500);
    const agent = makeAgent({ result: longResult });
    persistAgentRun(agent, 0);

    const parsed = JSON.parse(fs.readFileSync(path.join(runsDir, `${agent.id}.json`), "utf8"));
    expect(parsed.result.length).toBeLessThan(longResult.length);
    expect(parsed.result).toMatch(/\[truncated/);
    // The truncated result should start with the original MAX_RESULT_BYTES chars
    expect(parsed.result.startsWith("x".repeat(MAX_RESULT_BYTES))).toBe(true);
  });

  it("does not truncate a result that is exactly MAX_RESULT_BYTES long", () => {
    const exactResult = "y".repeat(MAX_RESULT_BYTES);
    const agent = makeAgent({ result: exactResult });
    persistAgentRun(agent, 0);

    const parsed = JSON.parse(fs.readFileSync(path.join(runsDir, `${agent.id}.json`), "utf8"));
    expect(parsed.result).toBe(exactResult);
    expect(parsed.result).not.toMatch(/truncated/);
  });

  it("passes through null result unchanged", () => {
    const agent = makeAgent({ result: null });
    persistAgentRun(agent, 0);

    const parsed = JSON.parse(fs.readFileSync(path.join(runsDir, `${agent.id}.json`), "utf8"));
    expect(parsed.result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("persistAgentRun — error resilience", () => {
  it("does not throw when runsDir is unwritable — error is swallowed", () => {
    const agent = makeAgent();
    // Temporarily point workspace-context at an unwritable path.
    const origGetPaths = workspaceContext.getProjectPaths.bind(workspaceContext);
    workspaceContext.getProjectPaths = () => ({ runsDir: "/nonexistent/__zana_test__/runs" });

    expect(() => persistAgentRun(agent, 0)).not.toThrow();

    // Restore
    workspaceContext.getProjectPaths = origGetPaths;
  });

  it("emits a console.warn (not throw) on write failure", () => {
    const agent = makeAgent();
    const origGetPaths = workspaceContext.getProjectPaths.bind(workspaceContext);
    workspaceContext.getProjectPaths = () => ({ runsDir: "/nonexistent/__zana_test__/runs" });

    const warns: any[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warns.push(args);

    persistAgentRun(agent, 0);

    console.warn = origWarn;
    workspaceContext.getProjectPaths = origGetPaths;

    expect(warns.length).toBeGreaterThan(0);
    // Warning should mention the agent id or "persist"
    const warnText = warns.flat().join(" ");
    expect(warnText).toMatch(new RegExp(agent.id + "|persist|failed"));
  });
});
