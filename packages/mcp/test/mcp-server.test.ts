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
  "../../dist/src/mcp-server.js"
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
