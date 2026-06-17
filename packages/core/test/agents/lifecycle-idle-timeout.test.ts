// Unit tests for the headless-agent IDLE timeout in agents/lifecycle.ts.
//
// Root cause this guards against: the timeout used to be a fixed WALL-CLOCK
// timer armed once at spawn. A long-but-healthy agent that streamed output
// past agentTimeoutMinutes (e.g. a scheduled `npm test`) was SIGTERMed
// (code 143) mid-run even while actively producing results.
//
// The fix reinterprets agentTimeoutMinutes as an INACTIVITY threshold: the
// agent is killed only after that many minutes with NO stdout. Every stdout
// chunk stamps agent.lastActivity, so a working agent keeps resetting the
// clock; a genuinely hung one (no output) still gets reaped.
//
// Strategy mirrors lifecycle-spawn-headless.test.ts: mock ./spawner (so
// spawnHeadless returns a fake EventEmitter-backed child) and ./model-router,
// drive stdout 'data' synchronously, and use vitest fake timers to advance
// the idle clock deterministically. No real process, no PTY, no network.

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let lastChild: any;
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 5151;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: false };
  // exitCode/signalCode null → the SIGKILL escalation arm would fire if reached.
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

vi.mock("@zana-ai/core/src/agents/spawner.ts", () => ({
  buildInteractiveCommand: vi.fn(() => ({ command: "echo", args: [] })),
  spawnHeadless: vi.fn(() => {
    lastChild = makeFakeChild();
    return lastChild;
  }),
}));

vi.mock("@zana-ai/core/src/agents/model-router.ts", () => ({
  selectModel: vi.fn(() => "claude-haiku-routed"),
  TIERS: {},
}));

import {
  spawnHeadlessAgent,
  getAgent,
} from "@zana-ai/core/src/agents/lifecycle.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

const PROFILE = {
  id: "tester",
  displayName: "Tester",
  icon: "🧪",
  category: "general",
};

// Default agentTimeoutMinutes is 10 → 600_000ms idle threshold.
const IDLE_MS = 10 * 60 * 1000;

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-idle-timeout-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function emitOutput(text: string) {
  lastChild.stdout.emit("data", Buffer.from(text));
}

describe("headless agent idle timeout", () => {
  it("does NOT kill a healthy agent that keeps streaming output past the threshold", () => {
    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "long test run" });
    expect(getAgent(agentId).state).toBe("active");

    // Simulate a long-but-healthy run: emit a chunk every ~9 minutes for a
    // total of ~36 minutes — well past the 10-minute threshold a wall-clock
    // timer would have used to kill it. lastActivity is re-stamped each chunk.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(9 * 60 * 1000);
      emitOutput("...test output chunk...\n");
    }

    // The idle timer must have re-armed on each chunk instead of firing.
    expect(lastChild.kill).not.toHaveBeenCalled();
    expect(getAgent(agentId).state).toBe("active");
  });

  it("kills an agent that produces NO output for the full idle threshold", () => {
    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "hung run" });
    expect(getAgent(agentId).state).toBe("active");

    // No stdout at all → lastActivity stays at spawn time. Cross the threshold.
    vi.advanceTimersByTime(IDLE_MS + 1000);

    // SIGTERM is delivered to the child group via signalChildTree → child.kill.
    expect(lastChild.kill).toHaveBeenCalled();
  });

  it("re-arms for the remaining window when output arrives just before the deadline", () => {
    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "borderline run" });

    // Idle to 1 minute shy of the threshold, then emit — resets the clock.
    vi.advanceTimersByTime(IDLE_MS - 60 * 1000);
    emitOutput("late chunk\n");

    // Advancing the original remaining minute must NOT kill — the clock reset.
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(lastChild.kill).not.toHaveBeenCalled();
    expect(getAgent(agentId).state).toBe("active");

    // But a further full idle window with no output DOES reap it.
    vi.advanceTimersByTime(IDLE_MS + 1000);
    expect(lastChild.kill).toHaveBeenCalled();
  });
});
