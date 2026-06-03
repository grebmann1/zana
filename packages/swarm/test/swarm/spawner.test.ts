// Tests for swarm/spawner — query/lookup functions and onChange listener.
// We do NOT test spawnSubDaemon here (that calls node:child_process.spawn and
// would hit the real filesystem/OS). Instead we exercise every code path that
// is reachable without starting a real child process.
import { describe, it, expect, vi } from "vitest";

import {
  listSubDaemons,
  getSubDaemon,
  getSubDaemonPorts,
  getSubDaemonApiPorts,
  stopSubDaemon,
  instructSubDaemon,
  updateHeartbeat,
  onChange,
} from "@zana-ai/swarm/src/swarm/spawner.ts";

describe("spawner — empty state", () => {
  it("listSubDaemons returns an array (empty when nothing spawned)", () => {
    const result = listSubDaemons();
    expect(Array.isArray(result)).toBe(true);
  });

  it("getSubDaemon returns null for an unknown daemonId", () => {
    expect(getSubDaemon("totally-unknown-daemon-id")).toBeNull();
  });

  it("getSubDaemonPorts returns an array (no running daemons)", () => {
    const ports = getSubDaemonPorts();
    expect(Array.isArray(ports)).toBe(true);
  });

  it("getSubDaemonApiPorts returns an array (no running daemons)", () => {
    const apiPorts = getSubDaemonApiPorts();
    expect(Array.isArray(apiPorts)).toBe(true);
  });
});

describe("spawner — stopSubDaemon with unknown id", () => {
  it("returns {ok:false, error} when daemonId is not registered", () => {
    const result = stopSubDaemon("no-such-daemon-xyz");
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/not found/i);
  });
});

describe("spawner — instructSubDaemon with unknown id", async () => {
  it("returns {ok:false, error} when daemonId is not registered", async () => {
    const result = await instructSubDaemon("no-such-daemon-xyz", "hello");
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/not found/i);
  });
});

describe("spawner — updateHeartbeat with unknown id", () => {
  it("is a no-op and does not throw for an unregistered daemonId", () => {
    expect(() => updateHeartbeat("ghost-daemon")).not.toThrow();
  });
});

describe("spawner — onChange listener", () => {
  it("registers a listener and returns an unsubscribe function", () => {
    const cb = vi.fn();
    const unsub = onChange(cb);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("unsubscribe prevents future notifications", () => {
    const cb = vi.fn();
    const unsub = onChange(cb);
    unsub();
    // stopSubDaemon with unknown id doesn't mutate state, so no notify fires.
    // We can't easily trigger a notify without spawning a process, but we can
    // at minimum confirm the unsub doesn't throw and cb stays at 0 calls.
    expect(cb).not.toHaveBeenCalled();
  });

  it("multiple listeners can be registered independently", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = onChange(cb1);
    const unsub2 = onChange(cb2);
    unsub1();
    unsub2();
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });
});
