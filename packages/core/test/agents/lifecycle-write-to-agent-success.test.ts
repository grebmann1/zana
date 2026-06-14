// Unit test for writeToAgent()'s SUCCESS path in agents/lifecycle.ts.
//
// lifecycle-write-listen.test.ts already covers the refusal branches, but only
// for UNKNOWN agents (writeToAgent returns false because agents.get() misses).
// The happy path — a registered agent whose childProcess.stdin is writable —
// is uncovered: it must serialize the message as JSON + "\n", hand it to
// stdin.write(), and return true. The registered-but-unwritable branch
// (agent present, stdin.writable === false) was likewise never exercised.
//
// Strategy: reuse the headless-spawn mocking pattern (mock ./spawner +
// ./model-router so no real process spawns) to land a real agent record in the
// module-private agents Map, then swap in a fake stdin with a write spy.
// Fully deterministic — no real process, no PTY, no network, no timers fire.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let lastChild: any;
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 7777;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: false };
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
  writeToAgent,
  getAgent,
} from "@zana-ai/core/src/agents/lifecycle.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-write-agent-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

const PROFILE = {
  id: "tester",
  displayName: "Tester",
  icon: "🧪",
  category: "general",
};

describe("writeToAgent — registered agent", () => {
  it("writes JSON + newline to a writable stdin and returns true", () => {
    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });

    // Swap in a writable stdin with a write spy on the agent's child process.
    const writeSpy = vi.fn();
    lastChild.stdin = { writable: true, write: writeSpy };

    const msg = { type: "user", text: "hello" };
    const result = writeToAgent(agentId, msg);

    expect(result).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    // Exact wire format: a single JSON line terminated by a newline.
    expect(writeSpy).toHaveBeenCalledWith(JSON.stringify(msg) + "\n");
  });

  it("returns false when the agent exists but its stdin is not writable", () => {
    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });
    // Default fake child has stdin.writable === false — do NOT swap it.
    expect(getAgent(agentId)).not.toBeNull();

    const result = writeToAgent(agentId, { type: "ping" });

    expect(result).toBe(false);
  });
});
