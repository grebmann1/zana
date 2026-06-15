// Unit tests for the MATCHED-agent branch of updateAgentFromHook() in
// agents/lifecycle.ts.
//
// The existing lifecycle-update-hook.test.ts only pins the guard paths
// (missing / unknown zana_terminal_id). This file covers the core behavior:
// when a payload's zana_terminal_id matches a registered agent, the function
// mutates that agent's state / lastAction per hook_event_name and re-emits a
// normalized AGENT_HOOK on the bus.
//
// Strategy: register a real agent record via spawnHeadlessAgent (with a known
// terminalId), mocking ./spawner + ./model-router so no process, PTY, or
// network is touched. We never emit child 'close', so the code===0 relative
// require in lifecycle is never hit — fully deterministic.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: false };
  child.kill = vi.fn();
  return child;
}

vi.mock("@zana-ai/core/src/agents/spawner.ts", () => ({
  buildInteractiveCommand: vi.fn(() => ({ command: "echo", args: [] })),
  spawnHeadless: vi.fn(() => makeFakeChild()),
}));

vi.mock("@zana-ai/core/src/agents/model-router.ts", () => ({
  selectModel: vi.fn(() => "claude-haiku-routed"),
  TIERS: {},
}));

import {
  spawnHeadlessAgent,
  updateAgentFromHook,
  getAgent,
} from "@zana-ai/core/src/agents/lifecycle.ts";
import { bus, EVENTS } from "@zana-ai/core/src/events/bus.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-update-hook-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

afterEach(() => {
  bus.removeAllListeners(EVENTS.AGENT_HOOK);
});

const PROFILE = { id: "tester", displayName: "Tester", icon: "🧪", category: "general" };

// Each test registers its own agent with a unique terminalId so the matched
// lookup (Array.find by terminalId) is unambiguous across parallel state.
function spawnWithTerminal(terminalId: string) {
  const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x", terminalId });
  return agentId;
}

describe("updateAgentFromHook — matched agent state transitions", () => {
  it("PreToolUse sets lastAction to 'Running: <tool>' and bumps lastActivity", () => {
    const terminalId = "t-match-pretool";
    const agentId = spawnWithTerminal(terminalId);
    const before = getAgent(agentId).lastActivity;

    updateAgentFromHook({
      zana_terminal_id: terminalId,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });

    const agent = getAgent(agentId);
    expect(agent.lastAction).toBe("Running: Bash");
    expect(agent.lastActivity).toBeGreaterThanOrEqual(before);
  });

  it("PostToolUse sets lastAction to 'Completed: <tool>'", () => {
    const terminalId = "t-match-posttool";
    const agentId = spawnWithTerminal(terminalId);

    updateAgentFromHook({
      zana_terminal_id: terminalId,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
    });

    expect(getAgent(agentId).lastAction).toBe("Completed: Read");
  });

  it("falls back to 'unknown' tool name when none is provided", () => {
    const terminalId = "t-match-unknown-tool";
    const agentId = spawnWithTerminal(terminalId);

    updateAgentFromHook({
      zana_terminal_id: terminalId,
      hook_event_name: "PreToolUse",
    });

    expect(getAgent(agentId).lastAction).toBe("Running: unknown");
  });

  it("Stop transitions the agent to idle", () => {
    const terminalId = "t-match-stop";
    const agentId = spawnWithTerminal(terminalId);

    updateAgentFromHook({ zana_terminal_id: terminalId, hook_event_name: "Stop" });

    const agent = getAgent(agentId);
    expect(agent.state).toBe("idle");
    expect(agent.lastAction).toBe("Waiting for input...");
  });

  it("SessionEnd transitions the agent to terminated", () => {
    const terminalId = "t-match-sessionend";
    const agentId = spawnWithTerminal(terminalId);

    updateAgentFromHook({ zana_terminal_id: terminalId, hook_event_name: "SessionEnd" });

    const agent = getAgent(agentId);
    expect(agent.state).toBe("terminated");
    expect(agent.lastAction).toBe("Session ended");
  });

  it("emits a normalized AGENT_HOOK payload for the matched agent", () => {
    const terminalId = "t-match-emit";
    const agentId = spawnWithTerminal(terminalId);

    const seen: any[] = [];
    bus.on(EVENTS.AGENT_HOOK, (p: any) => seen.push(p));

    updateAgentFromHook({
      zana_terminal_id: terminalId,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      duration_ms: 42,
    });

    const evt = seen.find((e) => e.agentId === agentId);
    expect(evt).toBeTruthy();
    expect(evt.zana_terminal_id).toBe(terminalId);
    expect(evt.hook_event_name).toBe("PreToolUse");
    expect(evt.tool_name).toBe("Bash");
    expect(evt.tool_input).toEqual({ command: "echo hi" });
    expect(evt.duration_ms).toBe(42);
  });
});
