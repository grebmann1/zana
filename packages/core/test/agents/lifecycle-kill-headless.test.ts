// Unit tests for killAgent() against a HEADLESS agent in agents/lifecycle.ts.
//
// Regression guard: killAgent() used to handle only the PTY (interactive) path
// — it killed agent.terminalId via the pty-host and ignored agent.childProcess.
// Headless agents own a real child process, so killing one was a silent no-op:
// the record flipped to "terminated" but the OS process kept running. Users
// could interrupt an agent but not actually kill it.
//
// These tests spawn a headless agent with a mocked child (an EventEmitter whose
// .kill is a spy), call killAgent, and assert the child is actually signalled
// and that we don't double-emit AGENT_TERMINATED when the process later closes.
//
// killAgent signals the whole process GROUP first (process.kill(-pid)) because
// headless children are spawned `detached` and lead their own group — this
// reaps the claude CLI's grandchildren (MCP servers, tool subprocesses) too. We
// stub process.kill so the group signal is observable and never touches a real
// pid, then assert the fallback child.kill on the group-gone path.
//
// Strategy mirrors lifecycle-spawn-headless.test.ts: mock ./spawner and
// ./model-router, drive everything synchronously, fully deterministic.

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
  // Mimic node's ChildProcess: null exitCode/signalCode while still running.
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
  killAgent,
  getAgent,
} from "@zana-ai/core/src/agents/lifecycle.ts";
import { bus, EVENTS } from "@zana-ai/contracts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-kill-hl-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

// Stub process.kill so group signals (process.kill(-pid, sig)) are observable
// and never reach a real OS process. Records [pid, signal] pairs.
let killCalls: Array<[number, string]>;
let realProcessKill: typeof process.kill;
beforeEach(() => {
  killCalls = [];
  realProcessKill = process.kill;
  // @ts-expect-error — test stub
  process.kill = (pid: number, sig: string) => {
    killCalls.push([pid, sig]);
    return true;
  };
});

afterEach(() => {
  process.kill = realProcessKill;
  vi.useRealTimers();
  bus.removeAllListeners(EVENTS.AGENT_TERMINATED);
});

const PROFILE = {
  id: "tester",
  displayName: "Tester",
  icon: "🧪",
  category: "general",
};

const groupSignals = (sig: string) =>
  killCalls.filter(([pid, s]) => pid === -lastChild.pid && s === sig);

describe("killAgent — headless agent", () => {
  let agentId: string;
  beforeEach(() => {
    ({ agentId } = spawnHeadlessAgent(PROFILE, { prompt: "long running task" }));
  });

  it("signals the child's process GROUP with SIGTERM (not just a no-op)", () => {
    expect(killAgent(agentId)).toBe(true);
    // Negative pid → whole group, so the claude CLI's grandchildren die too.
    expect(groupSignals("SIGTERM")).toHaveLength(1);
    // The group signal succeeded, so the direct child.kill fallback is unused.
    expect(lastChild.kill).not.toHaveBeenCalled();
  });

  it("falls back to a direct child.kill when the group signal fails", () => {
    // Simulate the group being gone (ESRCH) — process.kill throws.
    // @ts-expect-error — test stub
    process.kill = () => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    };
    killAgent(agentId);
    expect(lastChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("marks the agent terminated and records the kill reason", () => {
    killAgent(agentId);
    const agent = getAgent(agentId);
    expect(agent.state).toBe("terminated");
    expect(agent.killed).toBe(true);
    expect(agent.lastAction).toBe("Killed by user");
  });

  it("emits AGENT_TERMINATED exactly once with reason 'killed'", () => {
    const seen: any[] = [];
    const handler = (p: any) => {
      if (p.agentId === agentId) seen.push(p);
    };
    bus.on(EVENTS.AGENT_TERMINATED, handler);
    try {
      killAgent(agentId);
      // The real process now closes (SIGTERM took effect). The close handler
      // must NOT emit a second completed/errored termination.
      lastChild.emit("close", null);
      expect(seen).toHaveLength(1);
      expect(seen[0].reason).toBe("killed");
    } finally {
      bus.off(EVENTS.AGENT_TERMINATED, handler);
    }
  });

  it("escalates to SIGKILL if the child is still alive after the grace window", () => {
    vi.useFakeTimers();
    killAgent(agentId);
    expect(groupSignals("SIGTERM")).toHaveLength(1);
    expect(groupSignals("SIGKILL")).toHaveLength(0);

    // Child never exited — exitCode/signalCode still null after the grace window.
    vi.advanceTimersByTime(5000);
    expect(groupSignals("SIGKILL")).toHaveLength(1);
  });

  it("does NOT escalate to SIGKILL if the child already exited from SIGTERM", () => {
    vi.useFakeTimers();
    killAgent(agentId);
    // SIGTERM worked — process is gone.
    lastChild.exitCode = 0;
    vi.advanceTimersByTime(5000);
    expect(groupSignals("SIGKILL")).toHaveLength(0);
  });
});
