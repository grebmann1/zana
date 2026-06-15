// Deterministic coverage for spawnTerminal() in agents/pty-host.ts.
//
// The existing pty-host.test.ts deliberately never calls spawnTerminal because
// it would launch a real shell via node-pty. pty-host loads node-pty with a
// native require("node-pty") served by Node's createRequire — NOT Vite's module
// graph — so vi.mock() cannot intercept it. We patch Module._load (the pattern
// used by lifecycle-spawn-interactive.test.ts) to inject a controllable fake
// process, then pin the spawn lifecycle: live-registry insertion, idempotency,
// data fan-out to listeners, and removal on exit. No real PTY, no shell.
import Module from "node:module";
import { describe, it, expect, afterEach, afterAll } from "vitest";

let firedData: ((d: string) => void) | null = null;
let firedExit: ((e: { exitCode: number; signal?: number }) => void) | null = null;
let spawnCalls = 0;

const fakePty = {
  spawn: () => {
    spawnCalls++;
    return {
      pid: 4242,
      onData: (cb: any) => { firedData = cb; },
      onExit: (cb: any) => { firedExit = cb; },
      write: () => {},
      resize: () => {},
      kill: () => {},
    };
  },
};

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, ...rest: any[]) {
  if (request === "node-pty") return fakePty;
  return origLoad.call(this, request, parent, ...rest);
};

// Import after the _load patch so pty-host binds the fake node-pty.
const { spawnTerminal, getTerminal, listTerminals, onTerminalData, killAll } =
  await import("@zana-ai/core/src/agents/pty-host.ts");

afterAll(() => { (Module as any)._load = origLoad; });

describe("pty-host — spawnTerminal lifecycle", () => {
  afterEach(() => {
    killAll();
    firedData = null;
    firedExit = null;
    spawnCalls = 0;
  });

  it("registers a live terminal that getTerminal/listTerminals report", () => {
    const entry = spawnTerminal({ terminalId: "t1", cols: 100, rows: 30 });
    expect(entry.pid).toBe(4242);
    expect(getTerminal("t1")).toBe(entry);
    expect(listTerminals().map((t) => t.terminalId)).toContain("t1");
  });

  it("is idempotent — a second spawn for the same id reuses the entry without re-spawning", () => {
    const first = spawnTerminal({ terminalId: "t2" });
    const second = spawnTerminal({ terminalId: "t2" });
    expect(second).toBe(first);
    expect(spawnCalls).toBe(1);
  });

  it("fans out PTY data to registered onTerminalData listeners", () => {
    const received: Array<{ terminalId: string; data: string }> = [];
    const unsub = onTerminalData((evt) => received.push(evt));
    spawnTerminal({ terminalId: "t3" });
    firedData?.("hello");
    unsub();
    expect(received).toEqual([{ terminalId: "t3", data: "hello" }]);
  });

  it("removes the terminal from the live registry when the PTY exits", () => {
    spawnTerminal({ terminalId: "t4" });
    expect(getTerminal("t4")).not.toBeNull();
    firedExit?.({ exitCode: 0 });
    expect(getTerminal("t4")).toBeNull();
  });
});
