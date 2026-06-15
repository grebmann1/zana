// Smoke tests for packages/mcp/src/mcp-server.ts.
//
// mcp-server.ts is an entry-point script: it exports nothing and attaches
// side-effects (stdin listener, signal handlers, eager daemon boot) on import.
// Importing it inside the Vitest process is unsafe, so we test it by running
// the compiled dist binary in a subprocess and exercising the JSON-RPC stdio
// transport directly.
//
// What these tests verify:
//   1. The `initialize` handshake returns the correct protocol version and
//      server-info (hardcoded, no daemon dependency).
//   2. `tools/list` is rejected before the `initialize` handshake with the
//      correct JSON-RPC error code -32002.
//
// The tests do NOT require a real workspace, real Claude, or real network.
// The subprocess's eager daemon bootstrap may fail (expected in test envs) —
// that error is logged to stderr only and does not affect protocol responses.

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const SERVER_PATH = path.resolve(
  __dirname,
  "../dist/src/mcp-server.js"
);

/** Read the first newline-terminated JSON-RPC line from the subprocess stdout. */
function readLine(proc: ReturnType<typeof spawn>, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for MCP response`));
    }, timeoutMs);

    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(t);
        resolve(buf.slice(0, nl).trim());
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

/** Spawn the MCP server with a throwaway workspace. */
function spawnServer(tmpDir: string): ReturnType<typeof spawn> {
  return spawn("node", [SERVER_PATH], {
    env: {
      ...process.env,
      ZANA_AUTO_INIT: "0",          // skip workspace auto-init
      ZANA_TERMINAL_ID: "mcp-test", // silence attribution warning
      ZANA_WORKSPACE: tmpDir,
      ZANA_SKIP_MCP_INSTALL: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Read stderr until a line matching `predicate` appears, then resolve with it.
 * Used to observe the eager-boot diagnostics the server writes to stderr.
 */
function readStderrUntil(
  proc: ReturnType<typeof spawn>,
  predicate: (line: string) => boolean,
  timeoutMs = 5000
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for stderr line. Saw:\n${buf}`));
    }, timeoutMs);

    proc.stderr!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (const line of buf.split("\n")) {
        if (predicate(line)) {
          clearTimeout(t);
          resolve(line.trim());
          return;
        }
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

describe("mcp-server: JSON-RPC protocol (subprocess)", () => {
  it("responds to initialize with protocol version 2024-11-05 and server info", async () => {
    if (!fs.existsSync(SERVER_PATH)) {
      console.warn("[skip] dist/src/mcp-server.js not found — run npm run build first");
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-mcp-init-test-"));
    try {
      const proc = spawnServer(tmpDir);

      proc.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {} },
        }) + "\n"
      );

      const rawLine = await readLine(proc);
      proc.kill("SIGKILL");

      const msg = JSON.parse(rawLine);
      expect(msg.id).toBe(1);
      expect(msg.result).toMatchObject({
        protocolVersion: "2024-11-05",
        serverInfo: { name: "zana" },
        capabilities: expect.any(Object),
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 8000);

  it("rejects tools/list before initialize with JSON-RPC error -32002", async () => {
    if (!fs.existsSync(SERVER_PATH)) {
      console.warn("[skip] dist/src/mcp-server.js not found — run npm run build first");
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-mcp-uninit-test-"));
    try {
      const proc = spawnServer(tmpDir);

      // Send tools/list WITHOUT a prior initialize — server must reject it.
      proc.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }) + "\n"
      );

      const rawLine = await readLine(proc);
      proc.kill("SIGKILL");

      const msg = JSON.parse(rawLine);
      expect(msg.id).toBe(2);
      expect(msg.error).toBeDefined();
      expect(msg.error.code).toBe(-32002);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 8000);
});

describe("mcp-server: unknown method handling", () => {
  // The JSON-RPC dispatcher's `default` branch must reply to any unrecognized
  // method that carries an `id` with the standard "Method not found" error
  // (-32601). This path is daemon-independent and must work even before the
  // `initialize` handshake, so it is a stable, deterministic contract.
  it("rejects an unknown method with JSON-RPC error -32601", async () => {
    if (!fs.existsSync(SERVER_PATH)) {
      console.warn("[skip] dist/src/mcp-server.js not found — run npm run build first");
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-mcp-unknown-test-"));
    try {
      const proc = spawnServer(tmpDir);

      proc.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "totally/bogus",
          params: {},
        }) + "\n"
      );

      const rawLine = await readLine(proc);
      proc.kill("SIGKILL");

      const msg = JSON.parse(rawLine);
      expect(msg.id).toBe(7);
      expect(msg.error).toBeDefined();
      expect(msg.error.code).toBe(-32601);
      expect(msg.error.message).toContain("Method not found");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 8000);
});

describe("mcp-server: stdin buffer overflow guard", () => {
  // The stdin reader caps the unframed buffer at 10 MB (MCP_MAX_BUFFER_BYTES).
  // A client that streams a huge payload with no newline delimiter must not be
  // allowed to grow the buffer unbounded — the server flushes the buffer and
  // replies with JSON-RPC parse error -32700 (id: null). This guards against a
  // memory-exhaustion DoS and is fully deterministic (no daemon, no network).
  it("rejects an over-limit unframed payload with JSON-RPC error -32700", async () => {
    if (!fs.existsSync(SERVER_PATH)) {
      console.warn("[skip] dist/src/mcp-server.js not found — run npm run build first");
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-mcp-overflow-test-"));
    try {
      const proc = spawnServer(tmpDir);

      // The server replies and we SIGKILL it while the large payload is still
      // flushing, so the remaining write hits a closed pipe (EPIPE). That is
      // expected here — swallow it so it doesn't surface as an unhandled error.
      proc.stdin!.on("error", () => {});

      // 11 MB of non-newline bytes — exceeds the 10 MB cap before any line is
      // ever completed, so the overflow branch fires instead of JSON.parse.
      const oversized = "x".repeat(11 * 1024 * 1024);
      proc.stdin!.write(oversized);

      const rawLine = await readLine(proc);
      proc.kill("SIGKILL");

      const msg = JSON.parse(rawLine);
      expect(msg.id).toBeNull();
      expect(msg.error).toBeDefined();
      expect(msg.error.code).toBe(-32700);
      expect(msg.error.message).toContain("Buffer overflow");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 8000);
});

describe("mcp-server: workspace resolution (tenant isolation)", () => {
  // Tenant isolation depends on the boot-time workspace falling back to the
  // launching process's cwd (the active project) — NOT to the package install
  // dir. A regression here would silently funnel every project's tickets/runs
  // into one shared store. We observe the resolved workspace via the eager-boot
  // stderr diagnostic: "[zana-mcp] booting core in-process for: <workspace>".
  it("falls back to process.cwd() when ZANA_WORKSPACE is unset", async () => {
    if (!fs.existsSync(SERVER_PATH)) {
      console.warn("[skip] dist/src/mcp-server.js not found — run npm run build first");
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-mcp-cwd-test-"));
    // Resolve symlinks (macOS /var → /private/var) so the path matches what the
    // child process reports via process.cwd().
    const expectedCwd = fs.realpathSync(tmpDir);
    try {
      // Build env WITHOUT ZANA_WORKSPACE to force the cwd fallback.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ZANA_AUTO_INIT: "0",
        ZANA_TERMINAL_ID: "mcp-test",
        ZANA_SKIP_MCP_INSTALL: "1",
      };
      delete env.ZANA_WORKSPACE;

      const proc = spawn("node", [SERVER_PATH], {
        cwd: expectedCwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const line = await readStderrUntil(proc, (l) =>
        l.includes("booting core in-process for:")
      );
      proc.kill("SIGKILL");

      // The resolved workspace must be the cwd, not the package install dir.
      expect(line).toContain(`booting core in-process for: ${expectedCwd}`);
      expect(line).not.toContain("packages/mcp");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 8000);
});
