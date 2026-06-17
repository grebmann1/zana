// Unit tests for emitTerminated() in agents/lifecycle.ts.
//
// emitTerminated is described as the "single source of truth for the
// AGENT_TERMINATED payload shape" — multiple consumers (work/tickets,
// scheduling, intelligence, server, events/stats) depend on the exact
// fields present.  These tests pin the shape so regressions are caught
// immediately rather than discovered at integration time.
//
// Strategy: listen on the real in-process bus, call emitTerminated(), and
// assert the received payload.  No real spawning, no PTY, no network,
// no fake timers — fully deterministic.

import { describe, it, expect, afterEach } from "vitest";
import { bus, EVENTS } from "@zana-ai/contracts";
import { emitTerminated } from "@zana-ai/core/src/agents/lifecycle.ts";

// Collect every payload emitted during a test so assertions can inspect it.
function captureNext(): Promise<any> {
  return new Promise<any>((resolve) => {
    bus.once(EVENTS.AGENT_TERMINATED, (payload: any) => resolve(payload));
  });
}

afterEach(() => {
  // Remove any leftover listeners attached by this suite.
  bus.removeAllListeners(EVENTS.AGENT_TERMINATED);
});

// ---------------------------------------------------------------------------
describe("emitTerminated — payload shape", () => {
  it("includes agentId, profileId, and reason on a clean 'completed' emit", async () => {
    const captured = captureNext();
    emitTerminated("agent-1", "profile-1", "completed");
    const payload = await captured;

    expect(payload.agentId).toBe("agent-1");
    expect(payload.profileId).toBe("profile-1");
    expect(payload.reason).toBe("completed");
  });

  it("includes agentId, profileId, and reason for 'errored'", async () => {
    const captured = captureNext();
    emitTerminated("agent-2", "profile-2", "errored");
    const payload = await captured;

    expect(payload.agentId).toBe("agent-2");
    expect(payload.profileId).toBe("profile-2");
    expect(payload.reason).toBe("errored");
  });

  it("includes agentId, profileId, and reason for 'spawn-error'", async () => {
    const captured = captureNext();
    emitTerminated("agent-3", "profile-3", "spawn-error");
    const payload = await captured;

    expect(payload.reason).toBe("spawn-error");
  });

  it("merges extra.exitCode into the payload when provided", async () => {
    const captured = captureNext();
    emitTerminated("agent-4", "p4", "completed", { exitCode: 0 });
    const payload = await captured;

    expect(payload.exitCode).toBe(0);
  });

  it("merges extra.output into the payload when provided", async () => {
    const captured = captureNext();
    emitTerminated("agent-5", "p5", "completed", { exitCode: 0, output: "done" });
    const payload = await captured;

    expect(payload.output).toBe("done");
  });

  it("merges extra.error into the payload for spawn-error", async () => {
    const captured = captureNext();
    emitTerminated("agent-6", "p6", "spawn-error", { error: "ENOENT" });
    const payload = await captured;

    expect(payload.error).toBe("ENOENT");
  });

  it("works with an empty extra object — no extraneous fields injected", async () => {
    const captured = captureNext();
    emitTerminated("agent-7", "p7", "completed", {});
    const payload = await captured;

    expect(payload).not.toHaveProperty("exitCode");
    expect(payload).not.toHaveProperty("output");
    expect(payload).not.toHaveProperty("error");
  });

  it("works when extra is omitted entirely", async () => {
    const captured = captureNext();
    emitTerminated("agent-8", "p8", "errored");
    const payload = await captured;

    expect(payload.agentId).toBe("agent-8");
    expect(payload.profileId).toBe("p8");
    expect(payload.reason).toBe("errored");
  });

  it("null exitCode is preserved (not coerced to undefined)", async () => {
    const captured = captureNext();
    emitTerminated("agent-9", "p9", "errored", { exitCode: null });
    const payload = await captured;

    expect(Object.prototype.hasOwnProperty.call(payload, "exitCode")).toBe(true);
    expect(payload.exitCode).toBeNull();
  });
});
