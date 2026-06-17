// Unit tests for spawnHeadlessAgent() in agents/lifecycle.ts.
//
// spawnHeadlessAgent is the headless (one-shot, no-PTY) spawn path. It has
// no dedicated coverage despite encoding several behaviors other modules
// depend on:
//   - registers an agent record (mode "headless", state "active") that is
//     retrievable via getAgent(agentId) and carries pid + parentAgentId
//   - emits AGENT_SPAWNED on the event bus
//   - parses the child's stream-json stdout: a type:"result" line populates
//     agent.result + token/cost fields
//   - INVARIANT: streaming type:"assistant" text lands on agent.lastAssistantText
//     and must NOT overwrite agent.result (regression guard — see lifecycle.ts)
//
// Strategy: mock ./spawner (spawnHeadless → a fake EventEmitter-backed child)
// and ./model-router (selectModel → fixed model). No real process, no PTY,
// no network, no timers fire — fully deterministic.

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Fake child process the mocked spawnHeadless hands back. stdout/stderr are
// EventEmitters so the test can drive 'data' events synchronously.
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
import { bus, EVENTS } from "@zana-ai/contracts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

// Point moduleConfig at an empty tmp dir so the agent-timeout lookup falls
// back to in-memory DEFAULTS instead of resolving a real workspace.
beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-spawn-hl-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

const PROFILE = {
  id: "tester",
  displayName: "Tester",
  icon: "🧪",
  category: "general",
  // no `model` → routing kicks in and agent.model should reflect the routed value
};

describe("spawnHeadlessAgent — registration", () => {
  it("returns ids and registers a retrievable headless agent record", () => {
    const { agentId, terminalId } = spawnHeadlessAgent(PROFILE, {
      prompt: "do a thing",
      parentAgentId: "parent-1",
    });

    expect(typeof agentId).toBe("string");
    expect(terminalId).toContain("zana-hl-");

    const agent = getAgent(agentId);
    expect(agent).not.toBeNull();
    expect(agent.mode).toBe("headless");
    expect(agent.state).toBe("active");
    expect(agent.pid).toBe(4242);
    expect(agent.parentAgentId).toBe("parent-1");
    expect(agent.profileId).toBe("tester");
    // routed model is applied because the profile has no explicit model
    expect(agent.model).toBe("claude-haiku-routed");
  });

  // Complementary to the routed-model assertion above: when the profile
  // carries an explicit `model`, the 3-tier router MUST be bypassed
  // (lifecycle.ts: `profile.model ? profile : {...profile, model: routedModel}`).
  // The mocked selectModel always returns "claude-haiku-routed", so an explicit
  // model surviving onto the agent record proves routing was skipped — guarding
  // against a regression that would silently downgrade a caller-pinned model.
  it("bypasses model routing when the profile pins an explicit model", () => {
    const pinnedProfile = { ...PROFILE, model: "claude-opus-explicit" };
    const { agentId } = spawnHeadlessAgent(pinnedProfile, { prompt: "do a thing" });

    const agent = getAgent(agentId);
    expect(agent.model).toBe("claude-opus-explicit");
    expect(agent.model).not.toBe("claude-haiku-routed");
  });

  it("emits AGENT_SPAWNED on the bus with headless mode", () => {
    const seen: any[] = [];
    const handler = (p: any) => seen.push(p);
    bus.on(EVENTS.AGENT_SPAWNED, handler);
    try {
      const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });
      const evt = seen.find((e) => e.agentId === agentId);
      expect(evt).toBeTruthy();
      expect(evt.mode).toBe("headless");
      expect(evt.profileId).toBe("tester");
    } finally {
      bus.off(EVENTS.AGENT_SPAWNED, handler);
    }
  });
});

describe("spawnHeadlessAgent — stdout stream-json parsing", () => {
  let agentId: string;
  beforeEach(() => {
    ({ agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" }));
  });

  it("populates result and token/cost fields from a type:'result' line", () => {
    lastChild.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "result",
          result: "final answer",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
          total_cost_usd: 0.0123,
          duration_ms: 1500,
          num_turns: 3,
        }) + "\n",
      ),
    );

    const agent = getAgent(agentId);
    expect(agent.result).toBe("final answer");
    expect(agent.tokensIn).toBe(10);
    expect(agent.tokensOut).toBe(5);
    expect(agent.tokensCacheRead).toBe(2);
    expect(agent.costUsd).toBe(0.0123);
    expect(agent.durationMs).toBe(1500);
    expect(agent.numTurns).toBe(3);
  });

  it("INVARIANT: streaming assistant text sets lastAssistantText but NOT result", () => {
    lastChild.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "thinking out loud" }] },
        }) + "\n",
      ),
    );

    const agent = getAgent(agentId);
    expect(agent.lastAssistantText).toBe("thinking out loud");
    // result must remain null — only a type:"result" line may set it.
    expect(agent.result).toBeNull();
  });

  it("INVARIANT: successive assistant chunks overwrite lastAssistantText, then a later result wins", () => {
    // Regression guard for 685185e: narration streams in, the latest chunk
    // overwrites lastAssistantText, result stays null throughout, and the
    // terminal type:"result" populates result WITHOUT clobbering the last
    // narration the model emitted.
    const emit = (obj: any) =>
      lastChild.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));

    emit({ type: "assistant", message: { content: [{ type: "text", text: "step one" }] } });
    expect(getAgent(agentId).result).toBeNull();

    emit({ type: "assistant", message: { content: [{ type: "text", text: "still working…" }] } });
    let agent = getAgent(agentId);
    expect(agent.lastAssistantText).toBe("still working…"); // latest chunk wins
    expect(agent.result).toBeNull(); // narration must never leak into result

    emit({ type: "result", result: "the real final answer" });
    agent = getAgent(agentId);
    expect(agent.result).toBe("the real final answer");
    expect(agent.lastAssistantText).toBe("still working…"); // preserved, not overwritten
  });

  it("ignores non-JSON stdout lines without throwing", () => {
    expect(() => {
      lastChild.stdout.emit("data", Buffer.from("progress... 50%\nnot json\n"));
    }).not.toThrow();
    expect(getAgent(agentId).result).toBeNull();
  });
});

describe("spawnHeadlessAgent — claude session id capture", () => {
  let agentId: string;
  beforeEach(() => {
    ({ agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" }));
  });

  it("starts with claudeSessionId null and retains prompt + cwd for resume", () => {
    const agent = getAgent(agentId);
    expect(agent.claudeSessionId).toBeNull();
    expect(agent.prompt).toBe("x");
    expect(typeof agent.cwd).toBe("string");
    expect(agent.retryAttempts).toBe(0);
  });

  it("captures session_id from the init/system frame", () => {
    lastChild.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "sess-abc-123",
        }) + "\n",
      ),
    );
    expect(getAgent(agentId).claudeSessionId).toBe("sess-abc-123");
  });

  it("tolerates the legacy top-level sessionId shape", () => {
    lastChild.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ sessionId: "sess-legacy-9" }) + "\n"),
    );
    expect(getAgent(agentId).claudeSessionId).toBe("sess-legacy-9");
  });

  it("does not overwrite a captured session id with a later frame", () => {
    const emit = (obj: any) =>
      lastChild.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
    emit({ type: "system", subtype: "init", session_id: "first" });
    // A later frame that happens to carry a different session_id must not clobber.
    emit({ type: "system", session_id: "second" });
    expect(getAgent(agentId).claudeSessionId).toBe("first");
  });

  it("ignores empty/non-string session ids", () => {
    const emit = (obj: any) =>
      lastChild.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
    emit({ type: "system", session_id: "" });
    expect(getAgent(agentId).claudeSessionId).toBeNull();
    emit({ type: "system", session_id: 42 });
    expect(getAgent(agentId).claudeSessionId).toBeNull();
  });
});
