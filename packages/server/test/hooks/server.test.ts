// Unit tests for packages/server/src/hooks/server.ts
// Covers: registerRoute dispatch (GET + POST), 404 for unknown routes,
// 400 for malformed JSON body, and handler error → 500 response.
// Starts a real loopback HTTP server; no mock clock needed.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";

// Stub @zana-ai/core before hooks/server.ts lazily requires it.
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock("@zana-ai/core", () => ({
  util: { logger: { getLogger: () => fakeLogger } },
  project: { workspaceContext: { getProjectPaths: () => ({}) } },
  events: {
    service: { emit: vi.fn(), query: vi.fn(() => []) },
    log: { appendAudit: vi.fn() },
  },
  config: { DEFAULT_HOOK_PORT: 47801 },
}));

// Stub @zana-ai/work (ticket / scheduler proxies inside registerServiceRoutes).
vi.mock("@zana-ai/work", () => ({
  tickets: {
    service: {
      listTickets: vi.fn(() => []),
      getTicket: vi.fn(() => null),
      createTicket: vi.fn(() => ({})),
      updateTicket: vi.fn(() => ({})),
      claimTicket: vi.fn(() => ({})),
      completeTicket: vi.fn(() => ({})),
      commentTicket: vi.fn(() => ({})),
    },
  },
  scheduling: {
    service: { listSchedules: vi.fn(() => []), triggerSchedule: vi.fn(() => ({})) },
  },
}));

import {
  startHookServer,
  registerRoute,
  setSwarmModules,
} from "../../src/hooks/server.ts";

// ─── Stubs for swarm modules ─────────────────────────────────────────────────

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
  port = server.port;
});

afterAll(() => {
  server?.stop();
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
