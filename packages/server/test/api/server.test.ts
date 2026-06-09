// Unit tests for packages/server/src/api/server.ts
// Covers: /health with no daemon, 503 when daemon is null, 401 on bad token,
// 204 OPTIONS preflight, and stop() idempotency.
// Uses a real ephemeral HTTP server on 127.0.0.1 — no mocks needed for these
// routing-layer invariants.
//
// Note: tests that make outbound TCP connections are skipped when the runtime
// environment blocks loopback TCP (e.g. certain CI sandboxes where connect()
// returns EPERM). The stop() test is always run as it needs no connection.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Point HOME at a temp dir before core is imported so config picks it up.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zana-server-test-"));
process.env.HOME = tmpHome;

import * as apiServer from "../../src/api/server.ts";

const TOKEN = "srv-test-token-deadbeef";
const PORT = 47420;

// Pre-flight: detect whether loopback TCP connect() is permitted.
// We probe a port that should be unused; ECONNREFUSED → TCP works,
// EPERM → sandbox is blocking loopback connections.
const loopbackAvailable = await new Promise<boolean>((resolve) => {
  const probe = new net.Socket();
  probe.setTimeout(400);
  probe.connect(PORT + 999, "127.0.0.1");
  probe.on("connect", () => { probe.destroy(); resolve(true); });
  probe.on("timeout", () => { probe.destroy(); resolve(true); });
  probe.on("error", (err: any) => { probe.destroy(); resolve(err.code !== "EPERM"); });
});

// No daemon — exercises the "daemon not ready" guard on all non-health routes.
beforeAll(() => {
  if (loopbackAvailable) apiServer.start(null as any, PORT, { token: TOKEN });
});

afterAll(() => {
  try { apiServer.stop(); } catch {}
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function request(
  method: string,
  pathname: string,
  opts: { token?: string } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const useToken = "token" in opts ? opts.token : TOKEN;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (useToken) headers["Authorization"] = `Bearer ${useToken}`;

    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path: pathname, method, headers, timeout: 3000 },
      (res) => {
        let buf = "";
        res.on("data", (c) => { buf += c; });
        res.on("end", () => {
          let parsed: any = null;
          try { parsed = JSON.parse(buf); } catch { parsed = buf; }
          resolve({ status: res.statusCode!, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// /health — works even with no daemon
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!loopbackAvailable)("GET /health", () => {
  it("returns 200 with status:'ok' even when no daemon is running", async () => {
    const { status, body } = await request("GET", "/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("includes daemonId:null when no daemon is set", async () => {
    const { body } = await request("GET", "/health");
    expect(body.daemonId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Daemon-not-ready guard — non-/health routes return 503
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!loopbackAvailable)("daemon not ready guard", () => {
  it("GET /agents returns 503 when daemon is null", async () => {
    const { status, body } = await request("GET", "/agents");
    expect(status).toBe(503);
    expect(body.error).toBe("daemon not ready");
  });

  it("GET /status returns 503 when daemon is null", async () => {
    const { status } = await request("GET", "/status");
    expect(status).toBe(503);
  });

  it("GET /profiles returns 503 when daemon is null", async () => {
    const { status } = await request("GET", "/profiles");
    expect(status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!loopbackAvailable)("authentication", () => {
  it("returns 401 for a missing Authorization header", async () => {
    const { status } = await request("GET", "/health", { token: "" });
    expect(status).toBe(401);
  });

  it("returns 401 for a wrong token", async () => {
    const { status } = await request("GET", "/health", { token: "wrong-token" });
    expect(status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stop() idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("stop()", () => {
  it("is safe to call when no server is running", () => {
    // Create a separate server instance, stop it twice — must not throw.
    const s = apiServer.start(null as any, 47421, { token: TOKEN });
    expect(() => apiServer.stop()).not.toThrow();
    expect(() => apiServer.stop()).not.toThrow();
    // Re-bind for afterAll cleanup
    apiServer.start(null as any, PORT, { token: TOKEN });
  });
});
