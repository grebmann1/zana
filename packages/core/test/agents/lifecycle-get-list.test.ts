// Unit tests for getAgent() and listAgents() in agents/lifecycle.ts.
//
// These two public API functions have no dedicated coverage:
//
//   getAgent(agentId) — returns the registered agent object or null.
//     The happy-path (returning a live agent) requires spawning a real
//     process; here we cover the null / unknown-ID branch, which is
//     sufficient to pin the contract for callers like dispatch.ts.
//
//   listAgents() — returns a snapshot array of all registered agents.
//     We assert the structural invariant: always an Array, regardless
//     of how many agents exist.
//
// No real spawning, no PTY, no network — fully deterministic.

import { describe, it, expect } from "vitest";
import {
  getAgent,
  listAgents,
} from "@zana-ai/core/src/agents/lifecycle.ts";

// ─── getAgent ─────────────────────────────────────────────────────────────────

describe("getAgent — unknown agent", () => {
  it("returns null for an agent ID that has never been registered", () => {
    const result = getAgent("agent-id-that-does-not-exist-xyzzy-99");
    expect(result).toBeNull();
  });

  it("returns null for an empty-string agent ID", () => {
    expect(getAgent("")).toBeNull();
  });

  it("returns null for a numeric-string ID that was never registered", () => {
    expect(getAgent("12345")).toBeNull();
  });

  it("returns null for a UUID-shaped ID that was never registered", () => {
    expect(getAgent("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

// ─── listAgents ───────────────────────────────────────────────────────────────

describe("listAgents — structural invariants", () => {
  it("always returns an Array instance", () => {
    const result = listAgents();
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns a new snapshot on each call (not the same reference)", () => {
    const a = listAgents();
    const b = listAgents();
    // Each call should produce a distinct array object (snapshot semantics).
    expect(a).not.toBe(b);
  });

  it("returns an array whose items each have an id field when agents exist", () => {
    // If there are registered agents (from parallel test state), every entry
    // must have at least an id field — that is an invariant of the shape
    // produced by spawnInteractive / spawnHeadlessAgent.
    const agents = listAgents();
    for (const agent of agents) {
      expect(typeof agent.id).toBe("string");
    }
  });
});
