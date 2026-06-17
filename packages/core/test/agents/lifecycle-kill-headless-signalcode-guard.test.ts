// Regression guard for the SIGKILL-escalation condition in killAgent()
// (agents/lifecycle.ts):
//
//   setTimeout(() => {
//     if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
//   }, 5000);
//
// The escalation must NOT fire once the child is actually dead. node's
// ChildProcess reports a clean exit via `exitCode` (a number) but a
// signal-terminated exit via `signalCode` (e.g. "SIGTERM") with `exitCode`
// left null. The existing kill-headless test covers the exitCode-number path
// (clean exit); this one covers the realistic SIGTERM-success path, where the
// child dies FROM the signal we sent — exitCode stays null, signalCode is set —
// and the second clause of the guard is what prevents a spurious SIGKILL on an
// already-dead process.
//
// Strategy mirrors lifecycle-kill-headless.test.ts: mock ./spawner +
// ./model-router (no real process), fake timers, fully deterministic.

import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
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
} from "@zana-ai/core/src/agents/lifecycle.ts";
import { bus, EVENTS } from "@zana-ai/contracts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-kill-hl-signal-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

afterEach(() => {
  vi.useRealTimers();
  bus.removeAllListeners(EVENTS.AGENT_TERMINATED);
});

const PROFILE = { id: "tester", displayName: "Tester", icon: "🧪", category: "general" };

describe("killAgent — SIGKILL escalation guard reads signalCode", () => {
  let agentId: string;
  beforeEach(() => {
    ({ agentId } = spawnHeadlessAgent(PROFILE, { prompt: "long running task" }));
  });

  it("does NOT escalate to SIGKILL when SIGTERM already killed the child (signalCode set, exitCode still null)", () => {
    vi.useFakeTimers();
    killAgent(agentId);
    expect(lastChild.kill).toHaveBeenCalledWith("SIGTERM");

    // SIGTERM took effect via a signal: node sets signalCode, leaves exitCode null.
    lastChild.signalCode = "SIGTERM";
    vi.advanceTimersByTime(5000);

    expect(lastChild.kill).not.toHaveBeenCalledWith("SIGKILL");
  });
});
