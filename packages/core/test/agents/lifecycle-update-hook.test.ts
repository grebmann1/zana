// Unit tests for updateAgentFromHook() in agents/lifecycle.ts.
//
// updateAgentFromHook receives raw payloads from the Claude hook system,
// finds the matching agent by zana_terminal_id, and updates its state /
// emits AGENT_HOOK on the bus. These tests pin the guard paths — the
// function must never throw on a malformed payload and must not fire
// AGENT_HOOK when there is no matching agent.
//
// Strategy: import function and bus via source paths. No real spawning,
// no PTY, no network — fully deterministic.

import { describe, it, expect, afterEach } from "vitest";
import { bus, EVENTS } from "@zana-ai/core/src/events/bus.ts";
import { updateAgentFromHook } from "@zana-ai/core/src/agents/lifecycle.ts";

afterEach(() => {
  bus.removeAllListeners(EVENTS.AGENT_HOOK);
});

// ─── Guard path: missing zana_terminal_id ─────────────────────────────────

describe("updateAgentFromHook — missing terminalId", () => {
  it("does not throw when zana_terminal_id is absent from payload", () => {
    expect(() => updateAgentFromHook({})).not.toThrow();
  });

  it("does not throw when zana_terminal_id is an empty string", () => {
    expect(() => updateAgentFromHook({ zana_terminal_id: "" })).not.toThrow();
  });

  it("does not emit AGENT_HOOK when zana_terminal_id is absent", () => {
    let fired = false;
    bus.once(EVENTS.AGENT_HOOK, () => { fired = true; });
    updateAgentFromHook({});
    expect(fired).toBe(false);
  });

  it("does not emit AGENT_HOOK when zana_terminal_id is an empty string", () => {
    let fired = false;
    bus.once(EVENTS.AGENT_HOOK, () => { fired = true; });
    updateAgentFromHook({ zana_terminal_id: "" });
    expect(fired).toBe(false);
  });
});

// ─── Guard path: terminalId matches no known agent ────────────────────────

describe("updateAgentFromHook — unknown terminalId", () => {
  it("does not throw when the terminalId matches no registered agent", () => {
    expect(() =>
      updateAgentFromHook({ zana_terminal_id: "t-no-such-agent-xyzzy" })
    ).not.toThrow();
  });

  it("does not emit AGENT_HOOK when no agent matches the terminalId", () => {
    let fired = false;
    bus.once(EVENTS.AGENT_HOOK, () => { fired = true; });
    updateAgentFromHook({ zana_terminal_id: "t-no-such-agent-xyzzy" });
    expect(fired).toBe(false);
  });

  it("does not throw for an unknown hook_event_name with an unregistered terminalId", () => {
    expect(() =>
      updateAgentFromHook({
        zana_terminal_id: "t-no-such-agent-xyzzy",
        hook_event_name: "UnknownEvent",
      })
    ).not.toThrow();
  });

  it("does not throw when payload has all recognised fields but no matching agent", () => {
    expect(() =>
      updateAgentFromHook({
        zana_terminal_id: "t-no-such-agent-xyzzy",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        duration_ms: 42,
      })
    ).not.toThrow();
  });
});
