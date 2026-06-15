// spawnHeadless — headless argv assembly.
//
// spawnHeadless() wraps buildClaudeArgs with headless-only flags and decides
// how the prompt is passed. That assembly is NOT covered elsewhere:
// lifecycle-spawn-headless.test.ts mocks the whole ./spawner module out, and
// the build-claude-args*.test.ts files only exercise buildClaudeArgs directly.
//
// This pins the behaviors other code depends on:
//   - always prepends --output-format stream-json --verbose
//   - injects --permission-mode bypassPermissions when the profile omits one
//     (a headless child has no human to answer permission prompts)
//   - single-turn: prompt is passed via a trailing `-p <prompt>`
//   - multiTurn: adds --input-format stream-json and passes the prompt as a
//     bare positional (NOT behind -p)
//
// Strategy: mock only node:child_process.spawn to capture argv without
// launching a process. ZANA_WORKER_BIN is pinned so findClaude() is
// deterministic and never touches the filesystem. No real process, no timers.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => ({ calls: [] as Array<{ command: string; args: string[] }> }));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    h.calls.push({ command, args });
    const child: any = new EventEmitter();
    child.pid = 1234;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { writable: true };
    child.kill = () => {};
    return child;
  },
}));

import { spawnHeadless } from "@zana-ai/core/src/agents/spawner.ts";

const PROFILE = { id: "tester", displayName: "Tester" };

function lastArgs(): string[] {
  return h.calls[h.calls.length - 1].args;
}
function pairAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe("spawnHeadless — argv assembly", () => {
  const originalBin = process.env.ZANA_WORKER_BIN;

  beforeEach(() => {
    h.calls.length = 0;
    process.env.ZANA_WORKER_BIN = "/fake/claude";
  });

  afterEach(() => {
    if (originalBin === undefined) delete process.env.ZANA_WORKER_BIN;
    else process.env.ZANA_WORKER_BIN = originalBin;
  });

  it("single-turn run prepends stream-json/verbose, defaults to bypassPermissions, and trails -p <prompt>", () => {
    spawnHeadless(PROFILE, { prompt: "do a thing" });
    const args = lastArgs();

    expect(args[0]).toBe("--output-format");
    expect(args[1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(pairAfter(args, "--permission-mode")).toBe("bypassPermissions");

    // prompt is the last token, passed behind -p
    expect(args[args.length - 1]).toBe("do a thing");
    expect(args[args.length - 2]).toBe("-p");
    expect(args).not.toContain("--input-format");
  });

  it("multiTurn run adds --input-format stream-json and passes the prompt as a bare positional", () => {
    spawnHeadless(PROFILE, { prompt: "multi turn prompt", multiTurn: true });
    const args = lastArgs();

    expect(pairAfter(args, "--input-format")).toBe("stream-json");
    // prompt is positional — the token before it must NOT be -p
    expect(args[args.length - 1]).toBe("multi turn prompt");
    expect(args[args.length - 2]).not.toBe("-p");
  });

  it("respects an explicit permissionMode instead of forcing bypassPermissions", () => {
    spawnHeadless({ ...PROFILE, permissionMode: "plan" }, { prompt: "x" });
    expect(pairAfter(lastArgs(), "--permission-mode")).toBe("plan");
  });

  it("omits --resume by default (cold start)", () => {
    spawnHeadless(PROFILE, { prompt: "x" });
    expect(lastArgs()).not.toContain("--resume");
  });

  it("emits --resume <sessionId> when a resume id is supplied", () => {
    spawnHeadless(PROFILE, { prompt: "x", resumeSessionId: "sess-xyz-7" });
    expect(pairAfter(lastArgs(), "--resume")).toBe("sess-xyz-7");
  });

  it("--resume precedes the trailing -p prompt in the real arg vector", () => {
    // Pins the actual argv ordering the retry path produces: `claude ...
    // --resume <id> ... -p <prompt>`. The resume id must come before the
    // positional prompt block, and both must be present.
    spawnHeadless(PROFILE, { prompt: "continue please", resumeSessionId: "sess-9" });
    const args = lastArgs();
    const resumeIdx = args.indexOf("--resume");
    const pIdx = args.lastIndexOf("-p");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(pIdx).toBeGreaterThan(resumeIdx);
    expect(args[args.length - 1]).toBe("continue please");
  });
});
