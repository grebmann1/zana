/**
 * Tests for packages/core/src/agents/terminal-relay.ts
 *
 * Covers:
 *  - URL routing: non-terminal paths destroy the socket
 *  - Terminal-not-found: 404 response + socket destroyed
 *  - Missing WebSocket key: 400 response + socket destroyed
 *  - Valid handshake: 101 Switching Protocols, connection count increments
 *  - getConnectionCount: tracks active connections, decrements on close
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Mock pty-host before importing terminal-relay ───────────────────────────
// terminal-relay imports pty-host for getTerminal / onTerminalData /
// onTerminalExit / resizeTerminal / writeTerminal.  We supply a controllable
// fake so tests run without a real PTY process.

let mockTerminals: Record<string, any> = {};
const mockDataUnsub = vi.fn();
const mockExitUnsub = vi.fn();

vi.mock("@zana-ai/core/src/agents/pty-host.ts", () => ({
  getTerminal:    (id: string) => mockTerminals[id] ?? null,
  onTerminalData: vi.fn(() => mockDataUnsub),
  onTerminalExit: vi.fn(() => mockExitUnsub),
  resizeTerminal: vi.fn(),
  writeTerminal:  vi.fn(),
}));

import {
  acceptWebSocket,
  getConnectionCount,
} from "@zana-ai/core/src/agents/terminal-relay.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal EventEmitter-backed mock socket */
function makeMockSocket(overrides: Partial<{
  url: string;
  headers: Record<string, string>;
}> = {}) {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  const written: Buffer[] = [];
  let destroyed = false;

  const socket = {
    headers: overrides.headers ?? {},
    destroyed: false,
    write(data: string | Buffer) {
      written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
    destroy() {
      destroyed = true;
      socket.destroyed = true;
    },
    on(event: string, cb: (...args: any[]) => void) {
      (listeners[event] = listeners[event] ?? []).push(cb);
      return socket;
    },
    emit(event: string, ...args: any[]) {
      for (const cb of listeners[event] ?? []) cb(...args);
    },
    // Helpers for assertions
    _written: written,
    get _destroyed() { return destroyed; },
  };
  return socket;
}

function makeReq(url: string, headers: Record<string, string> = {}) {
  return { url, headers };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockTerminals = {};
  vi.clearAllMocks();
});

describe("getConnectionCount", () => {
  it("returns 0 when no connections are active", () => {
    expect(getConnectionCount()).toBe(0);
  });
});

describe("acceptWebSocket — routing guard", () => {
  it("destroys socket when path does not match /terminals/<id>/ws", () => {
    const socket = makeMockSocket();
    acceptWebSocket(makeReq("/not/a/terminal"), socket, null);
    expect(socket._destroyed).toBe(true);
  });

  it("destroys socket for a path that is almost right but malformed", () => {
    const socket = makeMockSocket();
    acceptWebSocket(makeReq("/terminals//ws"), socket, null);
    expect(socket._destroyed).toBe(true);
  });
});

describe("acceptWebSocket — 404 when terminal not found", () => {
  it("sends 404 and destroys socket when terminalId is unknown", () => {
    const socket = makeMockSocket();
    acceptWebSocket(makeReq("/terminals/unknown-id/ws"), socket, null);

    const written = socket._written.map((b) => b.toString()).join("");
    expect(written).toMatch(/404/);
    expect(socket._destroyed).toBe(true);
  });
});

describe("acceptWebSocket — 400 when WebSocket key is missing", () => {
  it("sends 400 and destroys socket when Sec-WebSocket-Key header is absent", () => {
    mockTerminals["tid-1"] = { terminalId: "tid-1" };
    const socket = makeMockSocket();
    // req has no sec-websocket-key header
    acceptWebSocket(makeReq("/terminals/tid-1/ws"), socket, null);

    const written = socket._written.map((b) => b.toString()).join("");
    expect(written).toMatch(/400/);
    expect(socket._destroyed).toBe(true);
  });
});

describe("acceptWebSocket — successful upgrade", () => {
  it("sends 101 Switching Protocols when terminal exists and key is present", () => {
    mockTerminals["tid-2"] = { terminalId: "tid-2" };
    const socket = makeMockSocket();
    const req = makeReq("/terminals/tid-2/ws", {
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    });

    acceptWebSocket(req, socket, null);

    const written = socket._written.map((b) => b.toString()).join("");
    expect(written).toMatch(/101 Switching Protocols/i);
    expect(written).toMatch(/Sec-WebSocket-Accept/i);
    expect(socket._destroyed).toBe(false);
  });

  it("increments connection count after a successful upgrade", () => {
    const before = getConnectionCount();
    mockTerminals["tid-3"] = { terminalId: "tid-3" };
    const socket = makeMockSocket();
    acceptWebSocket(
      makeReq("/terminals/tid-3/ws", { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" }),
      socket,
      null,
    );
    expect(getConnectionCount()).toBe(before + 1);

    // Trigger close to clean up (keep global count tidy across tests)
    socket.emit("close");
    expect(getConnectionCount()).toBe(before);
  });

  it("decrements connection count when the socket closes", () => {
    mockTerminals["tid-4"] = { terminalId: "tid-4" };
    const socket = makeMockSocket();
    acceptWebSocket(
      makeReq("/terminals/tid-4/ws", { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" }),
      socket,
      null,
    );
    const after = getConnectionCount();
    socket.emit("close");
    expect(getConnectionCount()).toBe(after - 1);
  });
});
