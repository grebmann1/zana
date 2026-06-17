import { describe, it, expect, vi } from "vitest";

import { bus, EVENTS } from "../src/bus.ts";

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

  // AGENT_ANOMALY is emitted by spawnHeadlessAgent's post-run anomaly detector
  // (lifecycle.ts). Downstream consumers key off this exact string, so pin it.
  it("defines AGENT_ANOMALY as 'agent:anomaly'", () => {
    expect(EVENTS.AGENT_ANOMALY).toBe("agent:anomaly");
  });

  // AGENT_RETRYING is the only event name the bulk assertion above never pins
  // (and the explicit AGENT_ANOMALY / deliberation pins skip it too). The retry
  // orchestrator emits this exact string and downstream consumers subscribe by
  // it, so a silent rename would slip past every other test here — the
  // duplicate-value guard only checks uniqueness, not the literal value.
  it("defines AGENT_RETRYING as 'agent:retrying'", () => {
    expect(EVENTS.AGENT_RETRYING).toBe("agent:retrying");
  });

  // The deliberation-extension events are the newest additions to the map and
  // were not pinned by the bulk assertion above. Downstream council/escalation
  // consumers subscribe by these exact strings, so a silent rename would break
  // them without tripping the duplicate-value guard. Pin them explicitly.
  it("defines the deliberation-extension event names", () => {
    expect(EVENTS.DELIBERATION_GENERALIST_ADDED).toBe(
      "deliberation:generalistAdded",
    );
    expect(EVENTS.DELIBERATION_HUMAN_NUDGE).toBe("deliberation:humanNudge");
  });
});

// ─── AGENT_ANOMALY round-trip ────────────────────────────────────────────────

describe("bus — AGENT_ANOMALY event", () => {
  it("delivers the anomaly payload shape to a listener", () => {
    const handler = vi.fn();
    const payload = {
      agentId: "a1",
      profileId: "p1",
      severity: "high",
      anomalies: ["nonzero-exit", "near-cost-ceiling"],
    };
    bus.on(EVENTS.AGENT_ANOMALY, handler);
    bus.emit(EVENTS.AGENT_ANOMALY, payload);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(payload);
    bus.off(EVENTS.AGENT_ANOMALY, handler);
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
