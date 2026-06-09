// Integration test for packages/server/src/hooks/server.ts.
//
// Strategy: redirect HOME so the REAL @zana-ai/core resolves all global paths
// under a tmpdir, and initialise a real workspace context. The hook server
// runs against the real core/work modules — no internal-module mocks. We
// assert HTTP behaviour over a real loopback HTTP server.
//
// Covers: registerRoute dispatch (GET + POST), 404 for unknown routes,
// 400 for malformed JSON body, and handler error → 500 response.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const { fakeHome, origHome, tmpWorkspace } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require("node:os") as typeof import("node:os");
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-hook-server-home-"));
  const tmpWorkspace = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-hook-server-ws-"));
  _fs.mkdirSync(_path.join(tmpWorkspace, ".zana"), { recursive: true });
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome, tmpWorkspace };
});

import {
  startHookServer,
  registerRoute,
  setSwarmModules,
} from "../../src/hooks/server.ts";
import * as core from "@zana-ai/core";

// ─── Stubs for swarm modules (these are caller-provided, not internal) ─────

const mockRouter = {
  deliverLocal: vi.fn(),
  drainInbox: vi.fn().mockReturnValue([]),
  peekInbox: vi.fn().mockReturnValue([]),
};
const mockEvents = { addEvent: vi.fn() };
const mockGetAgents = vi.fn().mockReturnValue([]);

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", timeout: 3000 },
      (res) => {
        let buf = "";
        res.on("data", (c) => { buf += c; });
        res.on("end", () => resolve({ status: res.statusCode!, body: buf }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function httpPost(
  port: number,
  path: string,
  rawBody: string,
  contentType = "application/json",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "Content-Length": Buffer.byteLength(rawBody),
        },
        timeout: 3000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => { buf += c; });
        res.on("end", () => resolve({ status: res.statusCode!, body: buf }));
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let server: any;
let port: number;

beforeAll(async () => {
  // Initialise a real workspace context — the hook server lazy-requires
  // workspace-context for ticket/scheduler routes, and an uninitialised
  // context throws on read.
  (core as any).project.workspaceContext.init(tmpWorkspace);

  setSwarmModules({ router: mockRouter, events: mockEvents, getAgents: mockGetAgents });

  // Register custom routes BEFORE startHookServer so they land in the Map
  // alongside the built-in routes registered inside startHookServer.
  registerRoute("GET", "/test/ping", (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pong: true }));
  });

  registerRoute("POST", "/test/echo", (_req, res, body) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ echo: body }));
  });

  registerRoute("GET", "/test/throw", (_req, _res) => {
    throw new Error("deliberate handler error");
  });

  // Use a port unlikely to conflict with integration tests (47900) or other
  // suite ports; the server will auto-increment on EADDRINUSE.
  server = await startHookServer(() => {}, async () => ({ ok: true }), 48050);
  if (!server) return; // server couldn't bind (e.g. sandbox EPERM) — tests will be skipped
  port = server.port;
});

// Skip individual tests when the server failed to start (e.g. network not available).
beforeEach((ctx) => {
  if (!server) ctx.skip();
});

afterAll(() => {
  server?.stop();
  process.env.HOME = origHome;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpWorkspace, { recursive: true, force: true }); } catch {}
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("hook-server — custom registerRoute", () => {
  it("server starts and binds a port", () => {
    expect(port).toBeGreaterThan(0);
  });

  it("dispatches a registered GET route and returns its response", async () => {
    const { status, body } = await httpGet(port, "/test/ping");
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ pong: true });
  });

  it("dispatches a registered POST route with the parsed JSON body", async () => {
    const payload = { hello: "world" };
    const { status, body } = await httpPost(port, "/test/echo", JSON.stringify(payload));
    expect(status).toBe(200);
    expect(JSON.parse(body).echo).toEqual(payload);
  });

  it("returns 404 for an unregistered route", async () => {
    const { status } = await httpGet(port, "/not/a/real/route");
    expect(status).toBe(404);
  });

  it("returns 400 when the POST body is malformed JSON", async () => {
    const { status } = await httpPost(port, "/test/echo", "not json{{{");
    expect(status).toBe(400);
  });

  it("returns 500 when a registered GET handler throws", async () => {
    const { status } = await httpGet(port, "/test/throw");
    expect(status).toBe(500);
  });

  it("built-in /health route is accessible", async () => {
    const { status, body } = await httpGet(port, "/health");
    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
  });
});
