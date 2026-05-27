import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { ClaudeSpawnAdapter } from "@zana/core/src/agents/runtimes/spawn-adapter.ts";

/**
 * Build a stand-in for ChildProcess that we can drive from tests:
 * - stdout: pushable Readable
 * - stdin:  capturing Writable
 * - emit "exit" to terminate
 *
 * We use this by mocking spawnHeadless() so the adapter receives our fake
 * instead of really spawning the claude binary.
 */
function buildFakeChild() {
  const stdoutChunks: Buffer[] = [];
  let stdoutPush: ((chunk: string | null) => void) | null = null;
  const stdout = new Readable({
    read() {
      stdoutPush = (chunk) => {
        if (chunk === null) this.push(null);
        else this.push(chunk);
      };
    },
  });
  // Flush the read trigger so stdoutPush is wired before any test pushes data.
  stdout.read(0);

  const stdinWrites: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, cb) {
      stdinWrites.push(chunk.toString("utf8"));
      cb();
    },
  });

  const child: any = new EventEmitter();
  child.pid = 12345;
  child.stdout = stdout;
  child.stdin = stdin;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  child._pushStdout = (line: string) => {
    if (!stdoutPush) {
      // Reader hasn't asked yet — defer one tick so the Readable hooks up.
      setImmediate(() => stdoutPush?.(line));
    } else {
      stdoutPush(line);
    }
  };
  child._exit = (code: number | null, signal: string | null = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    setImmediate(() => child.emit("exit", code, signal));
  };
  child._stdinWrites = stdinWrites;
  return child;
}

let mockChild: any;
vi.mock("@zana/core/src/agents/spawner.ts", () => ({
  spawnHeadless: vi.fn(() => mockChild),
  findClaude: vi.fn(() => "/usr/bin/claude"),
}));

describe("ClaudeSpawnAdapter", () => {
  beforeEach(() => {
    mockChild = buildFakeChild();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("kind is 'spawn'", () => {
    const adapter = new ClaudeSpawnAdapter();
    expect(adapter.kind).toBe("spawn");
  });

  it("spawn returns an AgentHandle with the child's pid", () => {
    const adapter = new ClaudeSpawnAdapter();
    const handle = adapter.spawn({}, {
      prompt: "do work",
      cwd: "/tmp",
      terminalId: "zana-hl-test1",
      profileId: "architect",
    });
    expect(handle.pid).toBe(12345);
  });

  it("onOutput delivers each newline-delimited stdout line", async () => {
    const adapter = new ClaudeSpawnAdapter();
    const handle = adapter.spawn({}, {
      prompt: "go",
      cwd: "/tmp",
      terminalId: "zana-hl-test2",
      profileId: "architect",
    });

    const lines: string[] = [];
    handle.onOutput((line) => lines.push(line));

    mockChild._pushStdout('{"type":"assistant","x":1}\n');
    mockChild._pushStdout('{"type":"user","y":2}\n');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(lines).toEqual([
      '{"type":"assistant","x":1}',
      '{"type":"user","y":2}',
    ]);
  });

  it("onOutput buffers partial lines until the newline arrives", async () => {
    const adapter = new ClaudeSpawnAdapter();
    const handle = adapter.spawn({}, {
      prompt: "go",
      cwd: "/tmp",
      terminalId: "zana-hl-test3",
      profileId: "architect",
    });

    const lines: string[] = [];
    handle.onOutput((line) => lines.push(line));

    mockChild._pushStdout('{"type":');
    await new Promise((r) => setImmediate(r));
    expect(lines).toEqual([]);

    mockChild._pushStdout('"assistant"}\n');
    await new Promise((r) => setImmediate(r));
    expect(lines).toEqual(['{"type":"assistant"}']);
  });

  it("onExit fires once with code/signal; trailing partial line is flushed first", async () => {
    const adapter = new ClaudeSpawnAdapter();
    const handle = adapter.spawn({}, {
      prompt: "go",
      cwd: "/tmp",
      terminalId: "zana-hl-test4",
      profileId: "architect",
    });

    const lines: string[] = [];
    let exitArgs: [number | null, string | null] | null = null;
    handle.onOutput((line) => lines.push(line));
    handle.onExit((code, signal) => {
      exitArgs = [code, signal];
    });

    mockChild._pushStdout('{"type":"final"}'); // no trailing newline
    mockChild._exit(0);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(lines).toEqual(['{"type":"final"}']);
    expect(exitArgs).toEqual([0, null]);
  });

  it("onExit registered AFTER exit still fires (late subscriber)", async () => {
    const adapter = new ClaudeSpawnAdapter();
    const handle = adapter.spawn({}, {
      prompt: "go",
      cwd: "/tmp",
      terminalId: "zana-hl-test5",
      profileId: "architect",
    });

    mockChild._exit(1, "SIGTERM");
    await new Promise((r) => setImmediate(r));

    let exitArgs: [number | null, string | null] | null = null;
    handle.onExit((code, signal) => {
      exitArgs = [code, signal];
    });
    await new Promise((r) => setImmediate(r));

    expect(exitArgs).toEqual([1, "SIGTERM"]);
  });

  it("write serializes JSON + newline to child stdin", () => {
    const adapter = new ClaudeSpawnAdapter();
    const handle = adapter.spawn({}, {
      prompt: "go",
      cwd: "/tmp",
      terminalId: "zana-hl-test6",
      profileId: "architect",
      multiTurn: true,
    });

    handle.write({ type: "user", message: { content: "hello" } });
    expect(mockChild._stdinWrites).toEqual([
      '{"type":"user","message":{"content":"hello"}}\n',
    ]);
  });

  it("kill forwards signal to the child", () => {
    const adapter = new ClaudeSpawnAdapter();
    const handle = adapter.spawn({}, {
      prompt: "go",
      cwd: "/tmp",
      terminalId: "zana-hl-test7",
      profileId: "architect",
    });
    handle.kill("SIGTERM");
    expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
