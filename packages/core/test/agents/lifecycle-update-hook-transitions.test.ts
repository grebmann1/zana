// Unit tests for updateAgentFromHook() in agents/lifecycle.ts — the HAPPY
// PATH where a matching agent IS found.
//
// The sibling lifecycle-update-hook.test.ts only pins the guard paths
// (missing terminalId / unknown agent). It explicitly cannot cover the
// state-transition branches because those require a registered agent, which
// normally means a real spawn. This file closes that gap by mocking ./spawner
// + ./model-router (same approach as lifecycle-spawn-headless.test.ts),
// registering a headless agent with a known terminalId, then driving each
// hook_event_name through updateAgentFromHook and asserting the resulting
// state / lastAction transition plus the AGENT_HOOK emission.
//
// No real process, no PTY, no network — fully deterministic.

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 7777;
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
import { bus, EVENTS } from "@zana-ai/contracts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-hook-trans-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

const PROFILE = { id: "tester", displayName: "Tester", icon: "🧪", category: "general" };

// Each test gets a freshly registered agent with a unique terminalId so the
// find-by-terminalId lookup is unambiguous and tests don't interfere.
let seq = 0;
let agentId: string;
let terminalId: string;

beforeEach(() => {
  terminalId = `t-hook-trans-${seq++}`;
  ({ agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x", terminalId }));
});

describe("updateAgentFromHook — state transitions on a matching agent", () => {
  it("PreToolUse sets lastAction to 'Running: <tool>'", () => {
    updateAgentFromHook({ zana_terminal_id: terminalId, hook_event_name: "PreToolUse", tool_name: "Bash" });
    expect(getAgent(agentId).lastAction).toBe("Running: Bash");
  });

  it("PostToolUse sets lastAction to 'Completed: <tool>'", () => {
    updateAgentFromHook({ zana_terminal_id: terminalId, hook_event_name: "PostToolUse", tool_name: "Edit" });
    expect(getAgent(agentId).lastAction).toBe("Completed: Edit");
  });

  it("falls back to nested tool.name when tool_name is absent", () => {
    updateAgentFromHook({ zana_terminal_id: terminalId, hook_event_name: "PreToolUse", tool: { name: "Grep" } });
    expect(getAgent(agentId).lastAction).toBe("Running: Grep");
  });

  it("uses 'unknown' when neither tool_name nor tool.name is present", () => {
    updateAgentFromHook({ zana_terminal_id: terminalId, hook_event_name: "PreToolUse" });
    expect(getAgent(agentId).lastAction).toBe("Running: unknown");
  });

  it("Stop moves the agent to idle and waits for input", () => {
    updateAgentFromHook({ zana_terminal_id: terminalId, hook_event_name: "Stop" });
    const agent = getAgent(agentId);
    expect(agent.state).toBe("idle");
    expect(agent.lastAction).toBe("Waiting for input...");
  });

  it("SessionStart marks the agent active", () => {
    updateAgentFromHook({ zana_terminal_id: terminalId, hook_event_name: "SessionStart" });
    const agent = getAgent(agentId);
    expect(agent.state).toBe("active");
    expect(agent.lastAction).toBe("Session started");
  });

  it("SessionEnd marks the agent terminated", () => {
    updateAgentFromHook({ zana_terminal_id: terminalId, hook_event_name: "SessionEnd" });
    const agent = getAgent(agentId);
    expect(agent.state).toBe("terminated");
    expect(agent.lastAction).toBe("Session ended");
  });

  it("advances lastActivity on every matching hook", () => {
    const agent = getAgent(agentId);
    agent.lastActivity = 0; // force a stale value
    updateAgentFromHook({ zana_terminal_id: terminalId, hook_event_name: "Stop" });
    expect(getAgent(agentId).lastActivity).toBeGreaterThan(0);
  });

  it("an unrecognized event bumps lastActivity but leaves state/lastAction untouched", () => {
    // None of the if/else branches match an unknown event (e.g. "Notification"),
    // so the default path must NOT mutate the agent's state or lastAction — only
    // lastActivity is stamped. A fresh headless agent starts active with the
    // "Running headless..." stamp; both must survive the unhandled event.
    const before = getAgent(agentId);
    expect(before.state).toBe("active");
    expect(before.lastAction).toBe("Running headless...");
    before.lastActivity = 0; // force a stale value to prove it gets refreshed

    updateAgentFromHook({ zana_terminal_id: terminalId, hook_event_name: "Notification" });

    const after = getAgent(agentId);
    expect(after.state).toBe("active"); // unchanged — no branch matched
    expect(after.lastAction).toBe("Running headless..."); // unchanged
    expect(after.lastActivity).toBeGreaterThan(0); // still refreshed
  });
});

describe("updateAgentFromHook — AGENT_HOOK emission for a matching agent", () => {
  it("emits AGENT_HOOK carrying the resolved agentId, event name, and tool name", () => {
    const seen: any[] = [];
    const handler = (p: any) => seen.push(p);
    bus.on(EVENTS.AGENT_HOOK, handler);
    try {
      updateAgentFromHook({
        zana_terminal_id: terminalId,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        duration_ms: 42,
      });
    } finally {
      bus.off(EVENTS.AGENT_HOOK, handler);
    }
    const evt = seen.find((e) => e.agentId === agentId);
    expect(evt).toBeTruthy();
    expect(evt.zana_terminal_id).toBe(terminalId);
    expect(evt.hook_event_name).toBe("PreToolUse");
    expect(evt.tool_name).toBe("Bash");
    expect(evt.duration_ms).toBe(42);
  });
});
