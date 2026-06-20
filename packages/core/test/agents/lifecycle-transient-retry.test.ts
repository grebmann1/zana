// Unit tests for the transient-error retry loop in agents/lifecycle.ts.
//
// When a headless worker exits nonzero AND its captured output classifies as a
// transient failure (rate-limit / 529 overload / network blip) AND it has a
// captured claude session id AND it is under the attempt ceiling, the agent is
// parked in state "retrying" and re-spawned with `--resume <sessionId>` after a
// backoff. Structural failures (auth/quota), missing session id, exhausted
// attempts, and clean exits all take the normal terminal path.
//
// Strategy: mock ./spawner so spawnHeadless returns a controllable fake child,
// and inject a synchronous retry scheduler via _setRetryScheduler so the
// backoff fires immediately (no real 30s wait). Each spawnHeadless call records
// its options so we can assert that the retry passed resumeSessionId.

import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let children: any[] = [];
let spawnOptions: any[] = [];
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 1000 + children.length;
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
  spawnHeadless: vi.fn((_profile: any, options: any) => {
    spawnOptions.push(options);
    const child = makeFakeChild();
    children.push(child);
    return child;
  }),
}));

vi.mock("@zana-ai/core/src/agents/model-router.ts", () => ({
  selectModel: vi.fn(() => "claude-routed"),
  TIERS: {},
}));

import {
  spawnHeadlessAgent,
  resumeHeadlessAgent,
  getAgent,
  _setRetryScheduler,
  _resetRetryScheduler,
} from "@zana-ai/core/src/agents/lifecycle.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-retry-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

const PROFILE = { id: "tester", displayName: "Tester", model: "claude-explicit" };

// Drive the init frame so the agent captures a session id (prerequisite for
// --resume). Returns the latest child.
function emitInit(child: any, sessionId = "sess-1") {
  child.stdout.emit(
    "data",
    Buffer.from(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\n"),
  );
}

// Synchronous scheduler: fire the backoff callback immediately so the retry
// happens inline within the test.
function fireImmediately() {
  _setRetryScheduler((cb) => cb());
}

beforeEach(() => {
  children = [];
  spawnOptions = [];
  fireImmediately();
});

afterEach(() => {
  _resetRetryScheduler();
});

describe("transient-error retry loop", () => {
  it("retries a rate-limit failure with --resume and the captured session id", () => {
    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "do work" });
    const first = children[0];
    emitInit(first, "sess-abc");

    // Simulate a 529 overload in the captured output, then a nonzero exit.
    first.stdout.emit("data", Buffer.from("API error: 529 Overloaded\n"));
    first.emit("close", 1);

    // The agent must have been re-spawned (2 spawns total) with --resume.
    expect(children.length).toBe(2);
    expect(spawnOptions[1].resumeSessionId).toBe("sess-abc");
    // On resume we send a continuation nudge, NOT the original task prompt —
    // re-sending "do work" would re-ask the whole task on top of the resumed
    // transcript.
    expect(spawnOptions[1].prompt).not.toBe("do work");
    expect(spawnOptions[0].prompt).toBe("do work"); // cold spawn used the real prompt

    const agent = getAgent(agentId);
    expect(agent.retryAttempts).toBe(1);
    // After the synchronous retry fired, the agent is active again on a fresh child.
    expect(agent.state).toBe("active");
    expect(agent.pid).toBe(children[1].pid);
  });

  it("classifies a transient failure reported on STDERR (where the CLI writes API errors)", () => {
    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "do work" });
    const first = children[0];
    emitInit(first, "sess-stderr");
    // The transient marker arrives on stderr, NOT stdout — the common case for
    // claude CLI API errors. The classifier must still see it.
    first.stderr.emit("data", Buffer.from("API Error: 529 Overloaded\n"));
    first.emit("close", 1);

    expect(children.length).toBe(2);
    expect(spawnOptions[1].resumeSessionId).toBe("sess-stderr");
    expect(getAgent(agentId).retryAttempts).toBe(1);
  });

  it("does NOT retry a structural (auth) failure — terminates immediately", () => {
    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });
    const first = children[0];
    emitInit(first, "sess-auth");
    first.stdout.emit("data", Buffer.from("HTTP 401 Unauthorized\n"));
    first.emit("close", 1);

    expect(children.length).toBe(1); // no re-spawn
    const agent = getAgent(agentId);
    expect(agent.state).toBe("errored");
    expect(agent.retryAttempts).toBe(0);
  });

  it("does NOT retry when no session id was captured", () => {
    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });
    const first = children[0];
    // No init frame → claudeSessionId stays null. Transient error, but unresumable.
    first.stdout.emit("data", Buffer.from("429 rate limit\n"));
    first.emit("close", 1);

    expect(children.length).toBe(1);
    expect(getAgent(agentId).state).toBe("errored");
  });

  // Note: "no retry on a clean (code 0) exit" is structurally guaranteed — the
  // retry check is gated behind `if (code !== 0 && ...)` in the close handler,
  // so a clean exit can never reach maybeScheduleTransientRetry. We don't unit
  // it directly because the code===0 branch does a relative
  // require("../modules/loader") the raw-.ts runner can't resolve (same
  // limitation noted in lifecycle-anomaly-emit.test.ts).

  it("stops retrying after the attempt ceiling and terminates errored", () => {
    moduleConfig.save({ modules: {}, system: { transientRetryMaxAttempts: 2, transientRetryBackoffMs: [0, 0, 0] } } as any);
    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });

    // Each spawned child: capture session, emit transient error, close nonzero.
    // The synchronous scheduler re-spawns inline, so we walk the children array.
    let idx = 0;
    // Guard against infinite loop in case the ceiling logic regresses.
    for (let guard = 0; guard < 10 && idx < children.length; guard++) {
      const child = children[idx];
      emitInit(child, "sess-loop");
      child.stdout.emit("data", Buffer.from("529 Overloaded\n"));
      child.emit("close", 1);
      idx++;
    }

    const agent = getAgent(agentId);
    // 1 initial + 2 retries = 3 spawns, then it gives up.
    expect(children.length).toBe(3);
    expect(agent.retryAttempts).toBe(2);
    expect(agent.state).toBe("errored");

    moduleConfig.save({ modules: {}, system: {} } as any);
  });

  it("retry is gated off when transientRetryMaxAttempts is 0", () => {
    moduleConfig.save({ modules: {}, system: { transientRetryMaxAttempts: 0 } } as any);
    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });
    const first = children[0];
    emitInit(first, "sess-off");
    first.stdout.emit("data", Buffer.from("529 Overloaded\n"));
    first.emit("close", 1);

    expect(children.length).toBe(1);
    expect(getAgent(agentId).state).toBe("errored");
    moduleConfig.save({ modules: {}, system: {} } as any);
  });

  it("a kill during the backoff window cancels the retry", () => {
    // Defer the scheduled retry so we can mutate state before it fires.
    let pending: (() => void) | null = null;
    _setRetryScheduler((cb) => { pending = cb; });

    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });
    const first = children[0];
    emitInit(first, "sess-kill");
    first.stdout.emit("data", Buffer.from("529 Overloaded\n"));
    first.emit("close", 1);

    const agent = getAgent(agentId);
    expect(agent.state).toBe("retrying");

    // Operator kills the agent mid-backoff.
    agent.killed = true;
    agent.state = "terminated";

    // Now the backoff timer fires — it must NOT re-spawn.
    pending?.();
    expect(children.length).toBe(1);
  });
});

describe("resumeHeadlessAgent — boot crash recovery", () => {
  it("re-spawns a crashed headless worker with --resume from its snapshot", () => {
    const newId = resumeHeadlessAgent({
      id: "old-dead-id",
      profileId: "tester",
      profileName: "Tester",
      mode: "headless",
      claudeSessionId: "sess-boot-9",
      prompt: "finish the migration",
      cwd: "/tmp/work",
      model: "claude-explicit",
      retryAttempts: 1,
    });

    expect(typeof newId).toBe("string");
    expect(newId).not.toBe("old-dead-id"); // fresh record, the dead one is gone
    expect(children.length).toBe(1);
    expect(spawnOptions[0].resumeSessionId).toBe("sess-boot-9");

    const agent = getAgent(newId!);
    expect(agent.mode).toBe("headless");
    expect(agent.claudeSessionId).toBe("sess-boot-9");
    expect(agent.resumedFromCrash).toBe(true);
    // Prior retry budget is carried forward, not reset.
    expect(agent.retryAttempts).toBe(1);
  });

  it("defaults retryAttempts to 0 when the snapshot omits it", () => {
    // Documented invariant (lifecycle.ts): the resumed record carries forward
    // `snapshot.retryAttempts ?? 0`. A snapshot that predates retry bookkeeping
    // (no retryAttempts field) must resume with a fresh count of 0, NOT
    // undefined — otherwise the first transient failure would compute the
    // backoff ladder index off `undefined` and the ceiling check would misbehave.
    const newId = resumeHeadlessAgent({
      id: "old-no-retrycount",
      profileId: "tester",
      profileName: "Tester",
      mode: "headless",
      claudeSessionId: "sess-no-retrycount",
      prompt: "resume me",
      cwd: "/tmp/work",
      // no retryAttempts field
    });

    expect(typeof newId).toBe("string");
    expect(getAgent(newId!).retryAttempts).toBe(0);
  });

  it("returns null when the snapshot lacks a session id (unresumable)", () => {
    const newId = resumeHeadlessAgent({
      id: "x",
      profileId: "tester",
      mode: "headless",
      prompt: "do work",
      // no claudeSessionId
    });
    expect(newId).toBeNull();
    expect(children.length).toBe(0);
  });

  it("returns null when the snapshot lacks a prompt (nothing to resume)", () => {
    // The guard is `!claudeSessionId || !prompt` — a snapshot with a session
    // id but no prompt is just as unresumable as one missing the session id,
    // and must NOT spawn a child.
    const newId = resumeHeadlessAgent({
      id: "y",
      profileId: "tester",
      mode: "headless",
      claudeSessionId: "sess-no-prompt",
      // no prompt
    });
    expect(newId).toBeNull();
    expect(children.length).toBe(0);
  });

  it("sends a continuation nudge, not the original prompt, on resume", () => {
    // Documented invariant (lifecycle.ts): a --resume re-spawn replays the
    // prior transcript from disk, so re-sending the ORIGINAL prompt would
    // re-ask the whole task on top of existing progress. Resume must instead
    // pass a short continuation nudge as the next turn.
    const ORIGINAL_PROMPT = "finish the migration";
    const newId = resumeHeadlessAgent({
      id: "old-dead-id",
      profileId: "tester",
      profileName: "Tester",
      mode: "headless",
      claudeSessionId: "sess-boot-nudge",
      prompt: ORIGINAL_PROMPT,
      cwd: "/tmp/work",
    });

    expect(typeof newId).toBe("string");
    expect(children.length).toBe(1);
    // The child is spawned with the nudge, never the original task prompt.
    expect(spawnOptions[0].prompt).not.toBe(ORIGINAL_PROMPT);
    expect(spawnOptions[0].prompt).toBe(
      "Continue the task from where you left off before the interruption.",
    );
    // The original prompt is still retained on the record for bookkeeping.
    expect(getAgent(newId!).prompt).toBe(ORIGINAL_PROMPT);
  });
});
