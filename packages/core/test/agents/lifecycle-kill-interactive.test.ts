// Unit test for killAgent()'s INTERACTIVE (PTY-backed) branch in agents/lifecycle.ts.
//
// lifecycle-kill-agent.test.ts covers the unknown-agent path (returns false) and
// lifecycle-kill-headless.test.ts covers the headless path (agent.childProcess →
// SIGTERM/SIGKILL). The remaining branch — an interactive agent that owns no
// childProcess but has a terminalId, so killAgent must route to
// getPtyHost().killTerminal(terminalId) — was never exercised.
//
// Strategy: reuse lifecycle-spawn-interactive.test.ts's mocking. ./pty-host is
// lazy-required from lifecycle.ts via Node's createRequire (not Vite's graph),
// so we patch Module._load to return a fake pty-host; ./spawner is mocked so no
// native module loads. Fake timers drive the 300ms deferred-write and 3000ms
// post-kill cleanup deterministically. No real process, PTY, network, or wall
// clock.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Module from "node:module";

const ptyHost = {
  spawnTerminal: vi.fn(),
  writeTerminal: vi.fn(),
  killTerminal: vi.fn(),
};

const origLoad = (Module as any)._load;
beforeAll(() => {
  (Module as any)._load = function (request: string, parent: any, ...rest: any[]) {
    if (request === "./pty-host" && parent?.filename?.endsWith("lifecycle.ts")) {
      return ptyHost;
    }
    return origLoad.call(this, request, parent, ...rest);
  };
});

afterAll(() => {
  (Module as any)._load = origLoad;
});

vi.mock("@zana-ai/core/src/agents/spawner.ts", () => ({
  buildInteractiveCommand: vi.fn(() => ({ command: "claude", args: [] })),
  spawnHeadless: vi.fn(),
}));

import { spawnInteractive, killAgent, getAgent } from "@zana-ai/core/src/agents/lifecycle.ts";
import { bus, EVENTS } from "@zana-ai/core/src/events/bus.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-kill-interactive-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  bus.removeAllListeners(EVENTS.AGENT_TERMINATED);
});

const PROFILE = {
  id: "interactive-kill-tester",
  displayName: "Interactive Kill Tester",
  icon: "🖥️",
  model: "claude-sonnet",
  defaultCwd: "/tmp/zana-cwd",
};

describe("killAgent — interactive (PTY-backed) agent", () => {
  it("routes to killTerminal, marks terminated, emits 'killed', and returns true", () => {
    vi.useFakeTimers();
    const terminalId = "term-kill-interactive";
    const terminatedSpy = vi.fn();
    bus.on(EVENTS.AGENT_TERMINATED, terminatedSpy);

    const { agentId } = spawnInteractive(PROFILE, { terminalId });
    // Sanity: interactive agents have no childProcess — exercises the PTY branch.
    expect(getAgent(agentId).childProcess).toBeUndefined();

    const result = killAgent(agentId);

    expect(result).toBe(true);
    // The PTY path must terminate the terminal (not a silent no-op).
    expect(ptyHost.killTerminal).toHaveBeenCalledTimes(1);
    expect(ptyHost.killTerminal).toHaveBeenCalledWith(terminalId);

    const agent = getAgent(agentId);
    expect(agent.state).toBe("terminated");
    expect(agent.lastAction).toBe("Killed by user");
    expect(agent.killed).toBe(true);

    expect(terminatedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId, profileId: PROFILE.id, reason: "killed" }),
    );
  });

  it("removes the agent record after the 3000ms cleanup window", () => {
    vi.useFakeTimers();
    const terminalId = "term-kill-cleanup";

    const { agentId } = spawnInteractive(PROFILE, { terminalId });
    killAgent(agentId);

    // Still present immediately after kill (terminated, but retained briefly).
    expect(getAgent(agentId)).not.toBeNull();

    vi.advanceTimersByTime(3000);

    expect(getAgent(agentId)).toBeNull();
  });
});
