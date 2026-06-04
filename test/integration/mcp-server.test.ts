import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";

const MCP_SERVER_PATH = path.resolve(__dirname, "../../packages/mcp/dist/bin/zana-mcp-server.js");
const WORKSPACE = path.resolve(__dirname, "../..");

let proc: ChildProcess;
let responseBuffer = Buffer.alloc(0);
let responseResolvers: Array<(msg: any) => void> = [];

function sendMessage(msg: object) {
  const json = JSON.stringify(msg);
  proc.stdin!.write(json + "\n");
}

function waitResponse(timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP response timeout")), timeoutMs);
    responseResolvers.push((msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

function parseResponses() {
  // Server uses newline-delimited JSON, not LSP-style Content-Length framing.
  while (true) {
    const newlineIdx = responseBuffer.indexOf(0x0a);
    if (newlineIdx === -1) break;
    const line = responseBuffer.slice(0, newlineIdx).toString("utf8").trim();
    responseBuffer = responseBuffer.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolver = responseResolvers.shift();
      if (resolver) resolver(msg);
    } catch {}
  }
}

describe("MCP Server (real stdio process)", () => {
  beforeAll(async () => {
    proc = spawn(process.execPath, [MCP_SERVER_PATH], {
      env: {
        ...process.env,
        ZANA_WORKSPACE: WORKSPACE,
        ZANA_AUTO_INIT: "0",
        // Integration test asserts agent/team-lifecycle tools are visible and
        // callable; expose them via the daemon-tools gate.
        ZANA_DAEMON_TOOLS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdout!.on("data", (chunk: Buffer) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      parseResponses();
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      // Uncomment for debugging: process.stderr.write(chunk);
    });
  }, 20000);

  afterAll(() => {
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
    }
  });

  it("completes MCP handshake (initialize + initialized)", async () => {
    const promise = waitResponse();
    sendMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const res = await promise;
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.serverInfo.name).toBe("zana");
    expect(res.result.capabilities.tools).toBeDefined();

    // Send initialized notification (no response expected)
    sendMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    // Small delay to let the server process the notification
    await new Promise((r) => setTimeout(r, 100));
  });

  it("rejects tools/list before initialization", async () => {
    // Spawn a fresh server to test pre-init rejection
    const freshProc = spawn(process.execPath, [MCP_SERVER_PATH], {
      env: { ...process.env, ZANA_WORKSPACE: WORKSPACE, ZANA_AUTO_INIT: "0", ZANA_DAEMON_TOOLS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let freshBuffer = Buffer.alloc(0);
    const freshPromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 10000);
      freshProc.stdout!.on("data", (chunk: Buffer) => {
        freshBuffer = Buffer.concat([freshBuffer, chunk]);
        const newlineIdx = freshBuffer.indexOf(0x0a);
        if (newlineIdx === -1) return;
        const line = freshBuffer.slice(0, newlineIdx).toString("utf8").trim();
        if (!line) return;
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
    });

    // Send tools/list WITHOUT initializing first
    const json = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} });
    freshProc.stdin!.write(json + "\n");

    const res = await freshPromise;
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32002);

    freshProc.kill("SIGTERM");
  }, 15000);

  it("lists tools via tools/list", async () => {
    const promise = waitResponse();
    sendMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    const res = await promise;
    expect(res.id).toBe(2);
    expect(res.result.tools).toBeDefined();
    expect(Array.isArray(res.result.tools)).toBe(true);
    expect(res.result.tools.length).toBeGreaterThan(10);

    const toolNames = res.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("zana_spawn_agent");
    expect(toolNames).toContain("zana_list_agents");
    expect(toolNames).toContain("zana_list_profiles");
    expect(toolNames).toContain("zana_ticket_create");
    expect(toolNames).toContain("zana_event_emit");
  });

  it("calls zana_list_profiles and gets results", async () => {
    const promise = waitResponse();
    sendMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "zana_list_profiles", arguments: {} },
    });

    const res = await promise;
    expect(res.id).toBe(3);
    expect(res.result).toBeDefined();
    expect(res.result.content).toBeDefined();
    expect(res.result.content[0].type).toBe("text");

    const profiles = JSON.parse(res.result.content[0].text);
    expect(Array.isArray(profiles)).toBe(true);
  }, 20000);

  it("calls zana_list_agents and gets results", async () => {
    const promise = waitResponse();
    sendMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "zana_list_agents", arguments: {} },
    });

    const res = await promise;
    expect(res.id).toBe(4);
    expect(res.result).toBeDefined();
    expect(res.result.content[0].type).toBe("text");

    const agents = JSON.parse(res.result.content[0].text);
    expect(Array.isArray(agents)).toBe(true);
  }, 20000);

  it("returns error for unknown tool", async () => {
    const promise = waitResponse();
    sendMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    });

    const res = await promise;
    expect(res.id).toBe(5);
    expect(res.result.content[0].text).toContain("unknown tool");
  }, 20000);

  it("returns -32601 for unknown methods", async () => {
    const promise = waitResponse();
    sendMessage({ jsonrpc: "2.0", id: 6, method: "fake/method", params: {} });

    const res = await promise;
    expect(res.id).toBe(6);
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32601);
  });

  it("handles multi-byte UTF-8 in arguments correctly", async () => {
    const promise = waitResponse();
    sendMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "zana_event_emit", arguments: { type: "test", payload: { msg: "日本語テスト 🚀" } } },
    });

    const res = await promise;
    expect(res.id).toBe(7);
    expect(res.result).toBeDefined();
    // Should not crash or corrupt the connection
    expect(res.result.isError).toBeFalsy();
  }, 20000);

  it("handles rapid sequential requests", async () => {
    const promises = [];
    for (let i = 100; i < 105; i++) {
      promises.push(waitResponse());
      sendMessage({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "zana_list_agents", arguments: {} } });
    }

    const results = await Promise.all(promises);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual([100, 101, 102, 103, 104]);
    for (const res of results) {
      expect(res.result.content[0].type).toBe("text");
    }
  }, 30000);
});
