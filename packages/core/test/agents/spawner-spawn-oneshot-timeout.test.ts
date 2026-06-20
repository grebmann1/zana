// spawnOneShot — the timeout / kill path.
//
// The sibling spawner-spawn-oneshot.test.ts deliberately emits events
// synchronously so the 60s default timeout never fires ("no fake timers"),
// which leaves the timeout branch of spawnOneShot (spawner.ts) unpinned:
// when the deadline elapses it sets killed=true, SIGTERMs the child, and the
// subsequent exit must resolve with the conventional timeout exit code 124
// (NOT the child's own code). This pins that contract with fake timers so no
// real wall-clock wait or real process is involved.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => ({ children: [] as any[] }));

vi.mock("node:child_process", () => ({
  spawn: () => {
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

describe("spawnOneShot — timeout path", () => {
  const originalBin = process.env.ZANA_WORKER_BIN;

  beforeEach(() => {
    h.children.length = 0;
    process.env.ZANA_WORKER_BIN = "/fake/claude";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalBin === undefined) delete process.env.ZANA_WORKER_BIN;
    else process.env.ZANA_WORKER_BIN = originalBin;
  });

  it("SIGTERMs the child on deadline and resolves with exit code 124", async () => {
    const p = spawnOneShot(PROFILE, "slow prompt", { timeout: 50 });
    const child = h.children[h.children.length - 1];

    // Deadline elapses before any exit: timer fires, child is SIGTERM'd.
    vi.advanceTimersByTime(50);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    // The kill triggers an exit (signal kills carry a null code); the timeout
    // exit code 124 must win over the child's own code.
    child.emit("exit", null);
    await expect(p).resolves.toEqual({ output: "", exitCode: 124 });
  });
});
