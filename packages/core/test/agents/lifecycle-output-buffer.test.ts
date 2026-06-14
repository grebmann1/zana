// Unit test for spawnHeadlessAgent()'s raw-stdout accumulation in
// agents/lifecycle.ts.
//
// The headless stdout handler keeps a raw `agent.outputBuffer` ALONGSIDE the
// stream-json parsing that populates `agent.result`. probe-agent.ts depends on
// this buffer as a fallback: when stream-json parsing never emits a
// type:"result" line (so `result` stays null), the probe reads
// `agent.outputBuffer` instead (see probe-agent.ts `_probePollResult` →
// `candidate = result || outputBuffer`). The sibling lifecycle-spawn-headless
// test covers `result`/token parsing and the non-JSON no-throw guard, but never
// asserts that outputBuffer accumulates the RAW text across chunks — that
// fallback path is otherwise untested.
//
// Strategy: reuse the headless-spawn mocking pattern (mock ./spawner +
// ./model-router so no real process spawns), drive synchronous 'data' events on
// the fake child's stdout, and assert outputBuffer. Fully deterministic — no
// real process, no PTY, no network, no timers fire.

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-output-buffer-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

const PROFILE = {
  id: "tester",
  displayName: "Tester",
  icon: "🧪",
  category: "general",
};

describe("spawnHeadlessAgent — raw outputBuffer accumulation", () => {
  let agentId: string;
  beforeEach(() => {
    ({ agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" }));
  });

  it("initializes outputBuffer to an empty string on spawn", () => {
    // Before any stdout data, the buffer must already exist (probe-agent reads
    // it unconditionally) and be the empty string, not undefined.
    expect(getAgent(agentId).outputBuffer).toBe("");
  });

  it("captures raw non-JSON stdout that never populates result (the probe fallback)", () => {
    lastChild.stdout.emit("data", Buffer.from("plain text answer, no stream-json\n"));

    const agent = getAgent(agentId);
    // result stays null because no type:"result" line was emitted...
    expect(agent.result).toBeNull();
    // ...but the raw text is preserved for probe-agent to fall back on.
    expect(agent.outputBuffer).toBe("plain text answer, no stream-json\n");
  });

  it("accumulates raw text across multiple stdout chunks in arrival order", () => {
    lastChild.stdout.emit("data", Buffer.from("first "));
    lastChild.stdout.emit("data", Buffer.from("second "));
    lastChild.stdout.emit("data", Buffer.from("third"));

    expect(getAgent(agentId).outputBuffer).toBe("first second third");
  });

  it("retains the verbatim bytes of parsed JSON lines too, not just unparseable ones", () => {
    const resultLine =
      JSON.stringify({ type: "result", result: "parsed answer" }) + "\n";
    lastChild.stdout.emit("data", Buffer.from(resultLine));

    const agent = getAgent(agentId);
    // The line was parsed into result...
    expect(agent.result).toBe("parsed answer");
    // ...AND its raw bytes remain in outputBuffer (raw buffer is a faithful
    // mirror of stdout, independent of what parsing extracted).
    expect(agent.outputBuffer).toBe(resultLine);
  });
});
