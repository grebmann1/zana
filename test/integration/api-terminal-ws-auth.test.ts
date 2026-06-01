import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as net from "node:net";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zana-ws-auth-"));
process.env.HOME = tmpHome;

import * as apiServer from "@zana-ai/server/src/api/server.ts";

const TOKEN = "test-token-ws-auth";
const PORT = 47915;

const stubDaemon = {
  daemonId: "test",
  workspace: tmpHome,
  agentManager: { listAgents: () => [] },
  teamManager: { listRunningTeams: () => [] },
};

beforeAll(() => {
  apiServer.start(stubDaemon, PORT, { token: TOKEN });
});

afterAll(() => {
  try { apiServer.stop(); } catch {}
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function rawUpgrade(headers: Record<string, string>): Promise<{ status: number; headers: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: PORT });
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("timeout")); });
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // Headers end with \r\n\r\n; we only care about the status line + headers.
      if (buf.includes("\r\n\r\n")) {
        const head = buf.slice(0, buf.indexOf("\r\n\r\n"));
        const m = head.match(/^HTTP\/1\.1 (\d+)/);
        socket.destroy();
        resolve({ status: m ? parseInt(m[1], 10) : 0, headers: head });
      }
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      const lines = [
        "GET /terminals/test-id/ws HTTP/1.1",
        `Host: 127.0.0.1:${PORT}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
      ];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });
  });
}

describe("WebSocket /terminals/:id/ws auth gate", () => {
  it("rejects unauthenticated upgrade with 401 and closes the socket", async () => {
    const res = await rawUpgrade({});
    expect(res.status).toBe(401);
  });

  it("rejects upgrade with a wrong bearer token (401)", async () => {
    const res = await rawUpgrade({ Authorization: "Bearer not-the-right-token" });
    expect(res.status).toBe(401);
  });

  it("rejects upgrade with a malformed Authorization header (401)", async () => {
    const res = await rawUpgrade({ Authorization: TOKEN });
    expect(res.status).toBe(401);
  });

  it("authenticated upgrade passes the auth gate (404 — terminal does not exist, but no 401)", async () => {
    // The terminal id doesn't refer to a real PTY, so terminal-relay returns
    // 404 — but only after we cleared the auth gate. The test asserts we are
    // NOT 401: getting past the gate is the contract this test owns.
    const res = await rawUpgrade({ Authorization: `Bearer ${TOKEN}` });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });
});
