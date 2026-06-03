// Unit tests for packages/server/src/api/health-monitor.ts
// Covers: exported constants, getStatus shape, check() stale-agent emission,
// check() skips terminated agents, check() skips fresh agents, check() emits
// memory warning when heap is over threshold, stop() is idempotent.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as monitor from "../../src/api/health-monitor.ts";

// ── Spy on the real bus rather than vi.mock, because the module uses a lazy
// CJS require() inside _bus() which resolves to the real module singleton at
// runtime in SSR/Node mode — vi.mock doesn't intercept those calls.  Spying
// on the singleton's emit directly is both simpler and more reliable.
import * as core from "@zana-ai/core";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<{
  id: string;
  profileName: string;
  state: string;
  lastActivityAt: string | null;
  spawnedAt: string | null;
}> = {}) {
  const defaults = {
    id: "agent-1",
    profileName: "worker",
    state: "running",
    lastActivityAt: new Date().toISOString(),
    spawnedAt: null,
  };
  return { ...defaults, ...overrides };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let emitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  monitor.stop(); // clear any dangling interval from a previous test
  // Re-init with an empty list so the module's getAgents variable is reset
  // to a known state; stop() does not clear it.
  monitor.init(() => []);
  monitor.stop();
  emitSpy = vi.spyOn(core.events.bus, "emit").mockImplementation(() => true as any);
});

afterEach(() => {
  monitor.stop();
  emitSpy.mockRestore();
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe("exported constants", () => {
  it("STALE_AGENT_THRESHOLD_MS is 30 minutes in ms", () => {
    expect(monitor.STALE_AGENT_THRESHOLD_MS).toBe(30 * 60 * 1000);
  });

  it("MEMORY_THRESHOLD_MB is 512", () => {
    expect(monitor.MEMORY_THRESHOLD_MB).toBe(512);
  });
});

// ── getStatus ─────────────────────────────────────────────────────────────────

describe("getStatus", () => {
  it("returns status: ok", () => {
    const s = monitor.getStatus(() => []);
    expect(s.status).toBe("ok");
  });

  it("reports total and active agent counts", () => {
    const agents = [
      makeAgent({ state: "running" }),
      makeAgent({ id: "agent-2", state: "terminated" }),
    ];
    const s = monitor.getStatus(() => agents);
    expect(s.agents.total).toBe(2);
    expect(s.agents.active).toBe(1);
  });

  it("memory fields are non-negative numbers", () => {
    const s = monitor.getStatus(() => []);
    expect(s.memory.heapUsed).toBeGreaterThanOrEqual(0);
    expect(s.memory.heapTotal).toBeGreaterThanOrEqual(0);
    expect(s.memory.rss).toBeGreaterThanOrEqual(0);
  });

  it("includes uptime, pid, and nodeVersion", () => {
    const s = monitor.getStatus(() => []);
    expect(typeof s.uptime).toBe("number");
    expect(s.pid).toBe(process.pid);
    expect(typeof s.nodeVersion).toBe("string");
  });

  it("defaults to the stored agentListFn when none is passed", () => {
    monitor.init(() => [makeAgent()]);
    const s = monitor.getStatus();
    expect(s.agents.total).toBe(1);
  });
});

// ── check — stale agents ──────────────────────────────────────────────────────

describe("check — stale agent detection", () => {
  it("emits health:stale-agent for an agent inactive beyond the threshold", () => {
    const staleTs = new Date(
      Date.now() - monitor.STALE_AGENT_THRESHOLD_MS - 1000,
    ).toISOString();
    monitor.init(() => [makeAgent({ lastActivityAt: staleTs })]);

    monitor.check();

    expect(emitSpy).toHaveBeenCalledWith(
      "health:stale-agent",
      expect.objectContaining({ agentId: "agent-1" }),
    );
  });

  it("does NOT emit for a terminated agent even if it is stale", () => {
    const staleTs = new Date(
      Date.now() - monitor.STALE_AGENT_THRESHOLD_MS - 1000,
    ).toISOString();
    monitor.init(() => [makeAgent({ state: "terminated", lastActivityAt: staleTs })]);

    monitor.check();

    expect(emitSpy).not.toHaveBeenCalledWith("health:stale-agent", expect.anything());
  });

  it("does NOT emit for a fresh agent well within the threshold", () => {
    monitor.init(() => [makeAgent({ lastActivityAt: new Date().toISOString() })]);

    monitor.check();

    expect(emitSpy).not.toHaveBeenCalledWith("health:stale-agent", expect.anything());
  });

  it("falls back to spawnedAt when lastActivityAt is null", () => {
    const staleTs = new Date(
      Date.now() - monitor.STALE_AGENT_THRESHOLD_MS - 5000,
    ).toISOString();
    monitor.init(() => [makeAgent({ lastActivityAt: null, spawnedAt: staleTs })]);

    monitor.check();

    expect(emitSpy).toHaveBeenCalledWith(
      "health:stale-agent",
      expect.objectContaining({ agentId: "agent-1" }),
    );
  });

  it("produces no stale-agent events when the agent list is empty", () => {
    // beforeEach leaves monitor in stopped state with an empty agent list.
    monitor.init(() => []);
    expect(() => monitor.check()).not.toThrow();
    expect(emitSpy).not.toHaveBeenCalledWith("health:stale-agent", expect.anything());
  });
});

// ── check — memory warning ────────────────────────────────────────────────────

describe("check — memory warning", () => {
  it("emits health:memory-warning when heap exceeds MEMORY_THRESHOLD_MB", () => {
    const overThreshold = (monitor.MEMORY_THRESHOLD_MB + 50) * 1024 * 1024;
    vi.spyOn(process, "memoryUsage").mockReturnValueOnce({
      heapUsed: overThreshold,
      heapTotal: overThreshold,
      rss: overThreshold,
      external: 0,
      arrayBuffers: 0,
    });

    monitor.init(() => []);
    monitor.check();

    expect(emitSpy).toHaveBeenCalledWith(
      "health:memory-warning",
      expect.objectContaining({ threshold: monitor.MEMORY_THRESHOLD_MB }),
    );
  });

  it("does NOT emit health:memory-warning when heap is below the threshold", () => {
    const underThreshold = (monitor.MEMORY_THRESHOLD_MB - 50) * 1024 * 1024;
    vi.spyOn(process, "memoryUsage").mockReturnValueOnce({
      heapUsed: underThreshold,
      heapTotal: underThreshold,
      rss: underThreshold,
      external: 0,
      arrayBuffers: 0,
    });

    monitor.init(() => []);
    monitor.check();

    expect(emitSpy).not.toHaveBeenCalledWith(
      "health:memory-warning",
      expect.anything(),
    );
  });
});

// ── stop ─────────────────────────────────────────────────────────────────────

describe("stop", () => {
  it("can be called repeatedly without throwing", () => {
    expect(() => {
      monitor.stop();
      monitor.stop();
      monitor.stop();
    }).not.toThrow();
  });

  it("stops the polling interval (no bus emissions after stop)", () => {
    vi.useFakeTimers();
    monitor.init(() => []);
    monitor.stop();

    vi.advanceTimersByTime(120_000);

    expect(emitSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
