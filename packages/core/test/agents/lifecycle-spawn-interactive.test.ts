// Unit tests for spawnInteractive() in agents/lifecycle.ts.
//
// spawnInteractive() had no real coverage (it was only mentioned in a comment
// in lifecycle-get-list.test.ts). It is a meaty function: it builds the
// interactive command, spawns a PTY terminal, registers an agent record in the
// "spawning" state, emits AGENT_SPAWNED, then — after a 300ms delay — writes
// the assembled command to the terminal and flips the record to "active".
//
// Strategy: mock ./pty-host (lazy-required) and ./spawner so no native node-pty
// module, no process, and no PTY are touched. Drive the 300ms delay with fake
// timers so the deferred state transition is deterministic. moduleConfig points
// at a temp path so the debounced disk snapshot is harmless.

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

// lifecycle.ts pulls in pty-host through a lazy `require("./pty-host")` inside
// getPtyHost() (node-pty is an optional native dep). That runtime require is
// served by Node's createRequire, NOT Vite's module graph, so vi.mock() — which
// only rewires static ESM imports — can't intercept it (the require throws
// "Cannot find module './pty-host'" because Node won't resolve the .ts source).
// Patch Module._load so the relative require from lifecycle.ts returns our fake.
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
  // args includes a value with a space so we can assert the quoting logic.
  buildInteractiveCommand: vi.fn(() => ({ command: "claude", args: ["--model", "opus mode"] })),
  spawnHeadless: vi.fn(),
}));

import { spawnInteractive, getAgent } from "@zana-ai/core/src/agents/lifecycle.ts";
import { bus, EVENTS } from "@zana-ai/core/src/events/bus.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-spawn-interactive-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  bus.removeAllListeners(EVENTS.AGENT_SPAWNED);
});

const PROFILE = {
  id: "interactive-tester",
  displayName: "Interactive Tester",
  icon: "🖥️",
  model: "claude-sonnet",
  defaultCwd: "/tmp/zana-cwd",
};

describe("spawnInteractive — registration and PTY setup", () => {
  it("registers an agent in the 'spawning' state and returns its ids", () => {
    vi.useFakeTimers();
    const terminalId = "term-spawn-register";

    const { agentId, terminalId: returnedTid } = spawnInteractive(PROFILE, { terminalId });

    expect(returnedTid).toBe(terminalId);
    const agent = getAgent(agentId);
    expect(agent).not.toBeNull();
    expect(agent.mode).toBe("interactive");
    expect(agent.state).toBe("spawning");
    expect(agent.profileId).toBe(PROFILE.id);
    expect(agent.terminalId).toBe(terminalId);
  });

  it("spawns the terminal with the resolved cwd and dimensions before writing", () => {
    vi.useFakeTimers();
    const terminalId = "term-spawn-dims";

    spawnInteractive(PROFILE, { terminalId, cols: 80, rows: 24 });

    expect(ptyHost.spawnTerminal).toHaveBeenCalledWith({
      terminalId,
      cwd: PROFILE.defaultCwd,
      cols: 80,
      rows: 24,
    });
    // The command is NOT written until the 300ms timer fires.
    expect(ptyHost.writeTerminal).not.toHaveBeenCalled();
  });

  it("emits AGENT_SPAWNED with mode 'interactive'", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    bus.on(EVENTS.AGENT_SPAWNED, spy);

    const { agentId } = spawnInteractive(PROFILE, { terminalId: "term-spawn-event" });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId, profileId: PROFILE.id, mode: "interactive" }),
    );
  });
});

describe("spawnInteractive — deferred command write", () => {
  it("writes the quoted command and flips state to 'active' after 300ms", () => {
    vi.useFakeTimers();
    const terminalId = "term-spawn-deferred";

    const { agentId } = spawnInteractive(PROFILE, { terminalId });
    expect(getAgent(agentId).state).toBe("spawning");

    vi.advanceTimersByTime(300);

    // Args containing spaces must be wrapped in quotes; the line ends with \n.
    expect(ptyHost.writeTerminal).toHaveBeenCalledWith(
      terminalId,
      'claude --model "opus mode"\n',
    );
    const agent = getAgent(agentId);
    expect(agent.state).toBe("active");
    expect(agent.lastAction).toBe("Claude session started");
  });
});
