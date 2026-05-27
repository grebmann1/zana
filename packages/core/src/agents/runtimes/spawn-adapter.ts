/**
 * ClaudeSpawnAdapter — RuntimeAdapter implementation for the existing
 * `claude` binary spawn path. Wraps spawnHeadless() so it satisfies the
 * RuntimeAdapter contract.
 *
 * This is the "spawn" runtime in the Phase 0 / Phase 2 plan. Wiring this
 * into manager.ts is Phase 2 scope (RuntimeAdapter selection in
 * spawnHeadlessAgent); the adapter is defined now to validate the
 * RuntimeAdapter interface against a real implementation before the SDK
 * adapter lands.
 */

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnHeadless, findClaude } from "../spawner";
import type {
  AgentHandle,
  RuntimeAdapter,
  RuntimeKind,
  SpawnOptions,
} from "../runtime-adapter";

export class ClaudeSpawnAdapter implements RuntimeAdapter {
  readonly kind: RuntimeKind = "spawn";

  spawn(profile: unknown, options: SpawnOptions): AgentHandle {
    const child = spawnHeadless(profile as any, {
      cwd: options.cwd,
      prompt: options.prompt,
      terminalId: options.terminalId,
      profileId: options.profileId,
      multiTurn: options.multiTurn || false,
    });
    return wrapChildProcess(child);
  }

  checkAvailable(): string | null {
    const bin = findClaude();
    // findClaude() returns the literal "claude" as last-resort fallback, even
    // when nothing is on PATH. Verify the resolved path actually exists; if
    // it's the bare "claude" sentinel and not on PATH, surface a clear error.
    if (path.isAbsolute(bin)) {
      if (!fs.existsSync(bin)) {
        return `claude worker binary not found at ${bin} (set ZANA_WORKER_BIN to override)`;
      }
      return null;
    }
    // Bare name — must resolve via PATH
    const dirs = (process.env.PATH || "").split(":");
    if (dirs.some((d) => d && fs.existsSync(path.join(d, bin)))) return null;
    return "no claude worker binary found (set ZANA_WORKER_BIN, install claude on PATH, or place it at ~/.local/bin/claude)";
  }
}

/**
 * Bridge a Node child_process onto AgentHandle. stdout is line-buffered
 * (stream-json frames Claude emits are newline-delimited) and forwarded
 * to onOutput subscribers; partial lines are held until the next chunk.
 */
function wrapChildProcess(child: ChildProcess): AgentHandle {
  const outputSubs = new Set<(line: string) => void>();
  const exitSubs = new Set<(code: number | null, signal: string | null) => void>();
  let buffered = "";
  let exited = false;

  child.stdout?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (line.length === 0) continue;
      for (const cb of outputSubs) {
        try { cb(line); } catch { /* listener errors must not stop dispatch */ }
      }
    }
  });

  child.on("exit", (code, signal) => {
    if (exited) return;
    exited = true;
    // Flush any trailing partial line so consumers see the complete tail.
    if (buffered.length > 0) {
      for (const cb of outputSubs) {
        try { cb(buffered); } catch { /* see above */ }
      }
      buffered = "";
    }
    for (const cb of exitSubs) {
      try { cb(code, signal); } catch { /* see above */ }
    }
  });

  return {
    pid: child.pid ?? null,
    kill(signal?: NodeJS.Signals) {
      try { child.kill(signal); } catch { /* already dead */ }
    },
    write(jsonMessage: unknown): boolean {
      const stdin = child.stdin;
      if (!stdin?.writable) return false;
      try {
        return stdin.write(JSON.stringify(jsonMessage) + "\n");
      } catch {
        return false;
      }
    },
    onOutput(cb) {
      outputSubs.add(cb);
      return () => outputSubs.delete(cb);
    },
    onExit(cb) {
      if (exited) {
        // Late subscriber: still deliver the terminal event so consumers
        // don't deadlock waiting for it. Fire on next tick.
        setImmediate(() => cb(child.exitCode, child.signalCode));
        return () => {};
      }
      exitSubs.add(cb);
      return () => exitSubs.delete(cb);
    },
  };
}
