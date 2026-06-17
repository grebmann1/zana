// Regression test for the BEST-EFFORT guarantee of the post-run anomaly-detection
// branch in spawnHeadlessAgent() (agents/lifecycle.ts).
//
// The detector is reached via a lazy `require("@zana-ai/work")` wrapped in a
// try/catch whose stated invariant is: "never let detection block
// termination/persistence." The sibling test (lifecycle-anomaly-emit) exercises
// the HAPPY path with the real, never-throwing detector — so the catch arm is
// otherwise uncovered. Here we force the detector to THROW and assert that:
//   - the child 'close' handler does not propagate the error,
//   - AGENT_TERMINATED is still emitted (termination is not blocked),
//   - AGENT_ANOMALY is NOT emitted and the agent record is NOT annotated.
//
// Strategy mirrors lifecycle-anomaly-emit: mock ./spawner + ./model-router (no
// real process) and drive 'close' synchronously on a fake child. Additionally
// we mock @zana-ai/work so its detector throws. We always close NONZERO to skip
// the code===0 loader require that the raw-.ts runner cannot resolve.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as work from "@zana-ai/work";

let lastChild: any;
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 4243;
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

// lifecycle reaches the detector via require("@zana-ai/work") — which shares the
// same cached CJS exports object as this import. Spying on the nested method
// therefore replaces exactly the function lifecycle calls. Force it to throw to
// simulate work being unloadable or the detector blowing up.
let detectSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-anomaly-resilient-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

beforeEach(() => {
  detectSpy = vi.spyOn(work.runs.anomaly, "detectAnomalies").mockImplementation(() => {
    throw new Error("boom: detector unavailable");
  });
});

afterEach(() => {
  bus.removeAllListeners(EVENTS.AGENT_ANOMALY);
  bus.removeAllListeners(EVENTS.AGENT_TERMINATED);
  vi.restoreAllMocks();
});

const PROFILE = { id: "tester", displayName: "Tester", icon: "🧪", category: "general" };

describe("spawnHeadlessAgent — anomaly detection is best-effort", () => {
  it("a throwing detector does not block termination and emits no AGENT_ANOMALY", () => {
    const anomalies: any[] = [];
    const terminated: any[] = [];
    bus.on(EVENTS.AGENT_ANOMALY, (p: any) => anomalies.push(p));
    bus.on(EVENTS.AGENT_TERMINATED, (p: any) => terminated.push(p));

    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });

    // The close handler must swallow the detector's exception.
    expect(() => lastChild.emit("close", 2)).not.toThrow();

    // The detector WAS reached (so we genuinely exercised the catch arm).
    expect(detectSpy).toHaveBeenCalledTimes(1);

    // Termination proceeds despite the failure.
    const term = terminated.find((e) => e.agentId === agentId);
    expect(term).toBeTruthy();
    expect(term.reason).toBe("errored");
    expect(term.exitCode).toBe(2);
    expect(getAgent(agentId).state).toBe("errored");

    // No anomaly was reported and the record was not annotated.
    expect(anomalies).toHaveLength(0);
    const agent = getAgent(agentId);
    expect(agent.anomalies).toBeUndefined();
    expect(agent.anomalySeverity).toBeUndefined();
  });
});
