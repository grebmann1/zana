// Unit test for killAgent()'s delayed registry cleanup in agents/lifecycle.ts.
//
// killAgent() does NOT remove the agent from the internal Map immediately: it
// flips the record to "terminated" (so the UI can render the final state) and
// schedules agents.delete(agentId) after a 3s grace window. Existing kill tests
// assert the signal, the state flip, and the single AGENT_TERMINATED emit — but
// none assert that the record is still present right after the kill yet gone
// once the cleanup window elapses. This test covers that timer branch.
//
// Strategy mirrors lifecycle-kill-headless.test.ts: mock ./spawner and
// ./model-router, drive the timers with vi.useFakeTimers, fully deterministic.

import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let lastChild: any;
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 7373;
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-kill-cleanup-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

afterEach(() => {
  vi.useRealTimers();
  bus.removeAllListeners(EVENTS.AGENT_TERMINATED);
});

const PROFILE = {
  id: "tester",
  displayName: "Tester",
  icon: "🧪",
  category: "general",
};

describe("killAgent — delayed registry cleanup", () => {
  let agentId: string;
  beforeEach(() => {
    vi.useFakeTimers();
    ({ agentId } = spawnHeadlessAgent(PROFILE, { prompt: "long running task" }));
  });

  it("keeps the terminated agent in the registry during the grace window", () => {
    killAgent(agentId);
    // Just before the 3s cleanup window — record must still be retrievable.
    vi.advanceTimersByTime(2999);
    const agent = getAgent(agentId);
    expect(agent).not.toBeNull();
    expect(agent.state).toBe("terminated");
  });

  it("removes the agent from the registry after the 3s cleanup window", () => {
    killAgent(agentId);
    vi.advanceTimersByTime(3000);
    expect(getAgent(agentId)).toBeNull();
  });
});
