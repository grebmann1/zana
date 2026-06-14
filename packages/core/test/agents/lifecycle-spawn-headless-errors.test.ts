// Unit tests for spawnHeadlessAgent()'s stderr-handling branch in
// agents/lifecycle.ts.
//
// lifecycle-spawn-headless.test.ts covers registration + the stdout
// stream-json happy path, but the stderr handler is uncovered:
//
//   child.stderr "data" containing "error"/"Error" surfaces the first 80
//   chars on agent.lastAction (prefixed "Error: ") WITHOUT changing the
//   agent's running state; benign stderr is ignored entirely.
//
// (The sibling child.on("error") spawn-failure branch is intentionally NOT
// exercised here — it performs an unguarded runtime require("../modules/loader")
// that only resolves against built dist, so it is covered via the dispatch
// integration path, mirroring the PTY-path note in lifecycle-kill-agent.test.ts.)
//
// Strategy mirrors lifecycle-spawn-headless.test.ts: mock ./spawner +
// ./model-router, drive the fake child's stderr synchronously. No real
// process, no PTY, no network — fully deterministic.

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
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

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-spawn-hl-err-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

const PROFILE = {
  id: "tester",
  displayName: "Tester",
  icon: "🧪",
  category: "general",
};

let agentId: string;
beforeEach(() => {
  ({ agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" }));
});

describe("spawnHeadlessAgent — stderr error surfacing", () => {
  it("captures stderr containing 'Error' onto lastAction without changing state", () => {
    lastChild.stderr.emit("data", Buffer.from("Error: something went sideways"));

    const agent = getAgent(agentId);
    expect(agent.lastAction).toBe("Error: Error: something went sideways");
    // stderr noise must not move the agent out of its running state.
    expect(agent.state).toBe("active");
  });

  it("matches lowercase 'error' too", () => {
    lastChild.stderr.emit("data", Buffer.from("fatal error in subprocess"));

    expect(getAgent(agentId).lastAction).toBe("Error: fatal error in subprocess");
  });

  it("ignores benign stderr that mentions neither 'error' nor 'Error'", () => {
    lastChild.stderr.emit("data", Buffer.from("just some progress output"));

    // lastAction remains the initial headless value.
    expect(getAgent(agentId).lastAction).toBe("Running headless...");
  });

  it("truncates the surfaced stderr to the first 80 characters", () => {
    const long = "error " + "x".repeat(200);
    lastChild.stderr.emit("data", Buffer.from(long));

    // "Error: " prefix + first 80 chars of the stderr text.
    expect(getAgent(agentId).lastAction).toBe("Error: " + long.slice(0, 80));
  });
});
