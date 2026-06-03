import { describe, it, expect, vi } from "vitest";

import { bus, EVENTS } from "../../src/events/bus.ts";

// ─── EVENTS constants ────────────────────────────────────────────────────────

describe("EVENTS constants", () => {
  it("defines all expected event name strings", () => {
    expect(EVENTS.AGENT_SPAWNED).toBe("agent:spawned");
    expect(EVENTS.AGENT_TERMINATED).toBe("agent:terminated");
    expect(EVENTS.AGENT_HOOK).toBe("agent:hook");
    expect(EVENTS.AGENT_STATUS_CHANGED).toBe("agent:statusChanged");
    expect(EVENTS.AGENT_PROBED).toBe("agent:probed");
    expect(EVENTS.TEAM_STARTED).toBe("team:started");
    expect(EVENTS.TEAM_STOPPED).toBe("team:stopped");
    expect(EVENTS.TEAM_WORKER_SPAWNED).toBe("team:workerSpawned");
    expect(EVENTS.ZANA_READY).toBe("zana:ready");
    expect(EVENTS.ZANA_SHUTDOWN).toBe("zana:shutdown");
    expect(EVENTS.PLUGIN_LOADED).toBe("plugin:loaded");
    expect(EVENTS.SETTINGS_CHANGED).toBe("settings:changed");
    expect(EVENTS.PROFILE_SAVED).toBe("profile:saved");
    expect(EVENTS.PROFILE_DELETED).toBe("profile:deleted");
    expect(EVENTS.RUN_STARTED).toBe("run:started");
    expect(EVENTS.RUN_ENDED).toBe("run:ended");
    expect(EVENTS.FILE_PRODUCED).toBe("file:produced");
    expect(EVENTS.DELIBERATION_PROPOSED).toBe("deliberation:proposed");
    expect(EVENTS.DELIBERATION_VOTE).toBe("deliberation:vote");
    expect(EVENTS.DELIBERATION_SYNTHESIS).toBe("deliberation:synthesis");
    expect(EVENTS.DELIBERATION_CONVERGED).toBe("deliberation:converged");
    expect(EVENTS.DELIBERATION_ESCALATED).toBe("deliberation:escalated");
    expect(EVENTS.DELIBERATION_OVERRIDE).toBe("deliberation:override");
    expect(EVENTS.DELIBERATION_DEGRADED).toBe("deliberation:degraded");
  });

  it("has no duplicate event name values", () => {
    const values = Object.values(EVENTS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

// ─── bus (EventEmitter) ──────────────────────────────────────────────────────

describe("bus", () => {
  it("is an EventEmitter that supports emit and on", () => {
    const handler = vi.fn();
    bus.on(EVENTS.ZANA_READY, handler);
    bus.emit(EVENTS.ZANA_READY, { hello: "world" });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ hello: "world" });
    bus.off(EVENTS.ZANA_READY, handler);
  });

  it("delivers payloads to multiple listeners independently", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on(EVENTS.AGENT_SPAWNED, h1);
    bus.on(EVENTS.AGENT_SPAWNED, h2);
    bus.emit(EVENTS.AGENT_SPAWNED, { agentId: "a1" });
    expect(h1).toHaveBeenCalledWith({ agentId: "a1" });
    expect(h2).toHaveBeenCalledWith({ agentId: "a1" });
    bus.off(EVENTS.AGENT_SPAWNED, h1);
    bus.off(EVENTS.AGENT_SPAWNED, h2);
  });

  it("does not call a listener after it is removed", () => {
    const handler = vi.fn();
    bus.on(EVENTS.ZANA_SHUTDOWN, handler);
    bus.off(EVENTS.ZANA_SHUTDOWN, handler);
    bus.emit(EVENTS.ZANA_SHUTDOWN);
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows at least 50 listeners before emitting a MaxListenersExceeded warning", () => {
    expect(bus.getMaxListeners()).toBeGreaterThanOrEqual(50);
  });
});
