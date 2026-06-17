// Unit tests for killAgent() in agents/lifecycle.ts.
//
// killAgent() has two distinct paths:
//   1. Unknown agent ID — must return false immediately, never touch PTY,
//      never emit AGENT_TERMINATED.
//   2. Known agent — requires a live agent in the internal Map, which in
//      turn requires a real PTY or careful injection; covered separately
//      via the dispatch integration tests.
//
// These tests exercise path 1 only: deterministic guard-path coverage
// with no real spawning, no PTY, no network.
//
// Pattern mirrors lifecycle-update-hook.test.ts and
// lifecycle-spawn-overload.test.ts — import from the .ts source path.

import { describe, it, expect, afterEach } from "vitest";
import { bus, EVENTS } from "@zana-ai/contracts";
import { killAgent } from "@zana-ai/core/src/agents/lifecycle.ts";

afterEach(() => {
  bus.removeAllListeners(EVENTS.AGENT_TERMINATED);
});

// ─── Guard path: agent ID not registered ─────────────────────────────────────

describe("killAgent — unknown agent ID", () => {
  it("returns false for an agent ID that was never registered", () => {
    expect(killAgent("agent-id-never-registered-xyzzy-001")).toBe(false);
  });

  it("returns false for an empty-string agent ID", () => {
    expect(killAgent("")).toBe(false);
  });

  it("returns false for a UUID-shaped ID that was never registered", () => {
    expect(killAgent("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("does not throw for any unregistered agent ID", () => {
    expect(() => killAgent("some-unknown-id-99")).not.toThrow();
  });

  it("does not emit AGENT_TERMINATED when the agent is not found", () => {
    let fired = false;
    bus.once(EVENTS.AGENT_TERMINATED, () => {
      fired = true;
    });
    killAgent("no-such-agent-xyzzy-002");
    expect(fired).toBe(false);
  });

  it("returns false on every successive call with the same unknown ID", () => {
    const id = "repeated-unknown-id-xyzzy";
    expect(killAgent(id)).toBe(false);
    expect(killAgent(id)).toBe(false);
  });
});
