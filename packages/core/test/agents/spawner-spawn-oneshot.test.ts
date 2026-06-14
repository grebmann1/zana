// spawnOneShot — one-shot query lifecycle.
//
// spawnOneShot() is the only exported spawner entrypoint with no direct test:
// spawner.test.ts / spawner-spawn-headless-args.test.ts cover buildClaudeArgs
// and spawnHeadless, and lifecycle-spawn-headless.test.ts mocks the module out.
// spawnOneShot has its own argv shape and resolves a Promise rather than
// returning the raw child, so its contract needs pinning independently.
//
// Pins the behaviors callers depend on:
//   - defaults permissionMode to bypassPermissions (no human to answer prompts)
//   - passes the prompt as a trailing `-p <prompt>`
//   - resolves { output: <trimmed stdout>, exitCode } on child exit
//   - passes a nonzero exit code straight through
//   - on spawn "error", resolves { output: "spawn error: …", exitCode: 1 }
//     instead of rejecting
//
// Strategy mirrors spawner-spawn-headless-args.test.ts: mock only
// node:child_process.spawn to hand back a controllable EventEmitter, and pin
// ZANA_WORKER_BIN so findClaude() never touches the filesystem. Events are
// emitted synchronously by the test, so the 60s default timeout never fires —
// no fake timers, no real process.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  children: [] as any[],
}));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    h.calls.push({ command, args });
    const child: any = new EventEmitter();
    child.pid = 4321;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { writable: true };
    child.kill = vi.fn();
    h.children.push(child);
    return child;
  },
}));

import { spawnOneShot } from "@zana-ai/core/src/agents/spawner.ts";

const PROFILE = { id: "tester", displayName: "Tester" };

function lastChild(): any {
  return h.children[h.children.length - 1];
}
function lastArgs(): string[] {
  return h.calls[h.calls.length - 1].args;
}

describe("spawnOneShot — one-shot query lifecycle", () => {
  const originalBin = process.env.ZANA_WORKER_BIN;

  beforeEach(() => {
    h.calls.length = 0;
    h.children.length = 0;
    process.env.ZANA_WORKER_BIN = "/fake/claude";
  });

  afterEach(() => {
    if (originalBin === undefined) delete process.env.ZANA_WORKER_BIN;
    else process.env.ZANA_WORKER_BIN = originalBin;
  });

  it("defaults to bypassPermissions and trails -p <prompt>", () => {
    void spawnOneShot(PROFILE, "what is 2+2?");
    const args = lastArgs();

    const pmIdx = args.indexOf("--permission-mode");
    expect(pmIdx).toBeGreaterThanOrEqual(0);
    expect(args[pmIdx + 1]).toBe("bypassPermissions");

    expect(args[args.length - 2]).toBe("-p");
    expect(args[args.length - 1]).toBe("what is 2+2?");
  });

  it("resolves trimmed stdout and the child exit code", async () => {
    const p = spawnOneShot(PROFILE, "hello");
    const child = lastChild();
    child.stdout.emit("data", Buffer.from("  the answer  "));
    child.emit("exit", 0);

    await expect(p).resolves.toEqual({ output: "the answer", exitCode: 0 });
  });

  it("passes a nonzero exit code straight through", async () => {
    const p = spawnOneShot(PROFILE, "hello");
    const child = lastChild();
    child.emit("exit", 2);

    await expect(p).resolves.toEqual({ output: "", exitCode: 2 });
  });

  it("resolves a spawn error instead of rejecting", async () => {
    const p = spawnOneShot(PROFILE, "hello");
    const child = lastChild();
    child.emit("error", new Error("boom"));

    await expect(p).resolves.toEqual({ output: "spawn error: boom", exitCode: 1 });
  });

  it("respects an explicit permissionMode instead of forcing bypassPermissions", () => {
    void spawnOneShot({ ...PROFILE, permissionMode: "plan" }, "x");
    const args = lastArgs();
    const pmIdx = args.indexOf("--permission-mode");
    expect(args[pmIdx + 1]).toBe("plan");
  });
});
