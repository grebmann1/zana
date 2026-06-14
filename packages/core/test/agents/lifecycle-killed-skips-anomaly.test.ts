// Regression guard for the killed-agent early-return in spawnHeadlessAgent()'s
// child 'close' handler (agents/lifecycle.ts).
//
// When killAgent() tears a headless agent down it sets agent.killed = true and
// signals SIGTERM. SIGTERM'd children usually exit NONZERO — which the post-run
// anomaly detector would otherwise flag as a "non-zero-exit" anomaly. That would
// be a false alarm: we killed the process on purpose. The close handler guards
// against this by returning early (persist only) when agent.killed is set,
// BEFORE the anomaly-detection block runs.
//
// This test asserts that a killed agent closing with a nonzero code:
//   - does NOT emit AGENT_ANOMALY
//   - is NOT annotated with anomalies on its record
//   - emits AGENT_TERMINATED exactly once, with reason "killed" (from killAgent,
//     not a second "errored" emit from the close handler)
//
// Strategy mirrors lifecycle-anomaly-emit.test.ts and lifecycle-kill-headless.test.ts:
// mock ./spawner + ./model-router (no real process), drive 'close' synchronously
// on a fake child, fake timers so the SIGKILL escalation never lingers. Fully
// deterministic — no real spawning, PTY, or network.

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
  // Mimic node's ChildProcess: null while still running (so killAgent's
  // SIGKILL-escalation guard reads the live state correctly).
  child.exitCode = null;
  child.signalCode = null;
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

import {
  spawnHeadlessAgent,
  killAgent,
  getAgent,
} from "@zana-ai/core/src/agents/lifecycle.ts";
import { bus, EVENTS } from "@zana-ai/core/src/events/bus.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-killed-anomaly-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

afterEach(() => {
  vi.useRealTimers();
  bus.removeAllListeners(EVENTS.AGENT_ANOMALY);
  bus.removeAllListeners(EVENTS.AGENT_TERMINATED);
});

const PROFILE = { id: "tester", displayName: "Tester", icon: "🧪", category: "general" };

describe("spawnHeadlessAgent — killed agent skips anomaly detection", () => {
  it("does NOT emit AGENT_ANOMALY when a killed agent closes nonzero", () => {
    vi.useFakeTimers();
    const anomalies: any[] = [];
    bus.on(EVENTS.AGENT_ANOMALY, (p: any) => anomalies.push(p));

    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "long running task" });
    expect(killAgent(agentId)).toBe(true);

    // SIGTERM took effect: the child exits with a nonzero code. A nonzero exit
    // is normally a detected anomaly, but the killed early-return must skip it.
    lastChild.emit("close", 2);

    expect(anomalies.find((e) => e.agentId === agentId)).toBeUndefined();
    const agent = getAgent(agentId);
    expect(agent.anomalies).toBeUndefined();
    expect(agent.anomalySeverity).toBeUndefined();
  });

  it("emits AGENT_TERMINATED exactly once with reason 'killed' (no second 'errored')", () => {
    vi.useFakeTimers();
    const terminated: any[] = [];
    const handler = (p: any) => {
      if (p.agentId === undefined) return;
      terminated.push(p);
    };
    bus.on(EVENTS.AGENT_TERMINATED, handler);

    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "long running task" });
    killAgent(agentId);
    lastChild.emit("close", 2);

    const mine = terminated.filter((e) => e.agentId === agentId);
    expect(mine).toHaveLength(1);
    expect(mine[0].reason).toBe("killed");
    expect(getAgent(agentId).state).toBe("terminated");
  });
});
