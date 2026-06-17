// Unit test for the "clean run" branch of the post-run anomaly-detection block
// in spawnHeadlessAgent() (agents/lifecycle.ts).
//
// lifecycle guards the emit/annotate on `verdict && verdict.anomalies.length > 0`.
// The sibling tests cover:
//   - lifecycle-anomaly-emit:      detector reports anomalies → emit + annotate
//   - lifecycle-anomaly-resilient: detector THROWS            → catch arm, no emit
// ...but NOT the path where the detector runs successfully and reports NOTHING.
// With the real detector this branch is unreachable here, because we must close
// NONZERO to skip the code===0 loader require the raw-.ts runner can't resolve —
// and a nonzero exit is itself an anomaly. So we spy the detector to return an
// empty verdict and assert lifecycle stays quiet: no AGENT_ANOMALY, no record
// annotation, while AGENT_TERMINATED still fires.
//
// Strategy mirrors the sibling anomaly tests: mock ./spawner + ./model-router
// (no real process) and drive 'close' synchronously on a fake child.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as work from "@zana-ai/work";

let lastChild: any;
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 4244;
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

// lifecycle reaches the detector via require("@zana-ai/work") — the same cached
// CJS exports object this import resolves to. Spying the nested method replaces
// exactly the function lifecycle calls. Force a clean (no-anomaly) verdict.
let detectSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-anomaly-clean-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

beforeEach(() => {
  detectSpy = vi
    .spyOn(work.runs.anomaly, "detectAnomalies")
    .mockImplementation(() => ({ anomalies: [], severity: "info" }));
});

afterEach(() => {
  bus.removeAllListeners(EVENTS.AGENT_ANOMALY);
  bus.removeAllListeners(EVENTS.AGENT_TERMINATED);
  vi.restoreAllMocks();
});

const PROFILE = { id: "tester", displayName: "Tester", icon: "🧪", category: "general" };

describe("spawnHeadlessAgent — clean run reports no anomaly", () => {
  it("does not emit AGENT_ANOMALY or annotate the record when the detector finds nothing", () => {
    const anomalies: any[] = [];
    const terminated: any[] = [];
    bus.on(EVENTS.AGENT_ANOMALY, (p: any) => anomalies.push(p));
    bus.on(EVENTS.AGENT_TERMINATED, (p: any) => terminated.push(p));

    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });
    lastChild.emit("close", 2);

    // The detector WAS consulted (the branch was genuinely reached)...
    expect(detectSpy).toHaveBeenCalledTimes(1);

    // ...but with an empty verdict, lifecycle stays quiet.
    expect(anomalies).toHaveLength(0);
    const agent = getAgent(agentId);
    expect(agent.anomalies).toBeUndefined();
    expect(agent.anomalySeverity).toBeUndefined();

    // Termination is unaffected — the normal lifecycle still completes.
    const term = terminated.find((e) => e.agentId === agentId);
    expect(term).toBeTruthy();
    expect(term.exitCode).toBe(2);
    expect(getAgent(agentId).state).toBe("errored");
  });
});
