// Unit tests for the post-run anomaly-detection branch of spawnHeadlessAgent()
// in agents/lifecycle.ts (added alongside the AGENT_ANOMALY bus event).
//
// On child 'close', lifecycle calls @zana-ai/work's pure detector
// (runs.anomaly.detectAnomalies) with { ...agent, exitCode }. When it reports
// anomalies, lifecycle must:
//   - annotate the agent record (agent.anomalies, agent.anomalySeverity)
//   - emit AGENT_ANOMALY with { agentId, profileId, severity, anomalies }
// ...without preventing the normal AGENT_TERMINATED emit.
//
// Strategy: mock ./spawner + ./model-router (no real process) and drive 'close'
// synchronously on the fake child. The detector itself is the REAL @zana-ai/work
// implementation — it's a pure, deterministic function, so this doubles as an
// integration check of the core↔work seam. No real spawning, PTY, or network.
//
// Note: we always close with a NONZERO exit code. The code===0 branch does a
// relative require("../modules/loader") that the raw-.ts test runner cannot
// resolve; the nonzero branch skips it and still runs the (unconditional)
// anomaly block. A nonzero exit is itself a detected anomaly (kind
// "non-zero-exit", severity "warn"), which is exactly what we assert.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let lastChild: any;
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
  spawnHeadless: vi.fn(() => (lastChild = makeFakeChild())),
}));

vi.mock("@zana-ai/core/src/agents/model-router.ts", () => ({
  selectModel: vi.fn(() => "claude-haiku-routed"),
  TIERS: {},
}));

import { spawnHeadlessAgent, getAgent } from "@zana-ai/core/src/agents/lifecycle.ts";
import { bus, EVENTS } from "@zana-ai/contracts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-anomaly-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

afterEach(() => {
  bus.removeAllListeners(EVENTS.AGENT_ANOMALY);
  bus.removeAllListeners(EVENTS.AGENT_TERMINATED);
});

const PROFILE = { id: "tester", displayName: "Tester", icon: "🧪", category: "general" };

describe("spawnHeadlessAgent — post-run anomaly detection", () => {
  it("emits AGENT_ANOMALY and annotates the agent on a nonzero exit", () => {
    const seen: any[] = [];
    bus.on(EVENTS.AGENT_ANOMALY, (p: any) => seen.push(p));

    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });
    lastChild.emit("close", 2);

    const evt = seen.find((e) => e.agentId === agentId);
    expect(evt).toBeTruthy();
    expect(evt.profileId).toBe("tester");
    expect(evt.severity).toBe("warn");
    expect(evt.anomalies).toHaveLength(1);
    expect(evt.anomalies[0].kind).toBe("non-zero-exit");
    // detail reflects the exitCode the detector was handed.
    expect(evt.anomalies[0].detail).toContain("code 2");

    const agent = getAgent(agentId);
    expect(agent.anomalies).toEqual(evt.anomalies);
    expect(agent.anomalySeverity).toBe("warn");
  });

  it("still emits AGENT_TERMINATED alongside the anomaly (detection is additive)", () => {
    const terminated: any[] = [];
    bus.on(EVENTS.AGENT_TERMINATED, (p: any) => terminated.push(p));

    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });
    expect(() => lastChild.emit("close", 2)).not.toThrow();

    const term = terminated.find((e) => e.agentId === agentId);
    expect(term).toBeTruthy();
    expect(term.reason).toBe("errored");
    expect(term.exitCode).toBe(2);
    expect(getAgent(agentId).state).toBe("errored");
  });

  it("escalates severity to critical when cost exceeds the budget ceiling", () => {
    const seen: any[] = [];
    bus.on(EVENTS.AGENT_ANOMALY, (p: any) => seen.push(p));

    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });
    // Feed a result line so the run record carries an over-budget cost
    // (DEFAULT_ANOMALY_LIMITS.maxCostUsd = 5 → $6 is "critical").
    lastChild.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ type: "result", result: "done", total_cost_usd: 6 }) + "\n"),
    );
    lastChild.emit("close", 2);

    const evt = seen.find((e) => e.agentId === agentId);
    expect(evt).toBeTruthy();
    // max severity across { non-zero-exit: warn, near-limit(cost): critical }.
    expect(evt.severity).toBe("critical");
    const kinds = evt.anomalies.map((a: any) => a.kind).sort();
    expect(kinds).toEqual(["near-limit", "non-zero-exit"]);
  });
});
