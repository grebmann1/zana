/**
 * Inbound-message tests for packages/core/src/agents/terminal-relay.ts.
 *
 * The sibling terminal-relay.test.ts covers the handshake, routing guards and
 * connection bookkeeping, but never feeds a client→server WebSocket frame in.
 * This pins the untested core: socket "data" → parseFrame (client frames are
 * MASKED per RFC 6455) → handleMessage dispatch. We assert that a JSON
 * "input"/"resize" control message routes to writeTerminal/resizeTerminal and
 * that a non-JSON text frame falls back to a raw writeTerminal.
 *
 * pty-host is the native-PTY boundary and is mocked (same pattern as the
 * sibling suite) so no real shell is spawned — fully deterministic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

let mockTerminals: Record<string, any> = {};

vi.mock("@zana-ai/core/src/agents/pty-host.ts", () => ({
  getTerminal:    (id: string) => mockTerminals[id] ?? null,
  onTerminalData: vi.fn(() => vi.fn()),
  onTerminalExit: vi.fn(() => vi.fn()),
  resizeTerminal: vi.fn(),
  writeTerminal:  vi.fn(),
}));

import { acceptWebSocket } from "@zana-ai/core/src/agents/terminal-relay.ts";
import { writeTerminal, resizeTerminal } from "@zana-ai/core/src/agents/pty-host.ts";

/** Encode a masked client→server text frame (payload < 126 bytes). */
function clientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const header = Buffer.from([0x81, 0x80 | payload.length]); // fin+text, masked
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function makeMockSocket() {
  const listeners: Record<string, Array<(...a: any[]) => void>> = {};
  const socket: any = {
    headers: {},
    destroyed: false,
    write: () => {},
    destroy() { socket.destroyed = true; },
    on(ev: string, cb: (...a: any[]) => void) { (listeners[ev] ??= []).push(cb); return socket; },
    emit(ev: string, ...a: any[]) { for (const cb of listeners[ev] ?? []) cb(...a); },
  };
  return socket;
}

function upgrade(terminalId: string) {
  mockTerminals[terminalId] = { terminalId };
  const socket = makeMockSocket();
  acceptWebSocket(
    { url: `/terminals/${terminalId}/ws`, headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } },
    socket,
    null,
  );
  return socket;
}

beforeEach(() => { mockTerminals = {}; vi.clearAllMocks(); });

describe("terminal-relay — inbound frame dispatch", () => {
  it("routes a masked JSON input frame to writeTerminal with the data", () => {
    const socket = upgrade("t-in");
    socket.emit("data", clientTextFrame(JSON.stringify({ type: "input", data: "ls\n" })));
    expect(writeTerminal).toHaveBeenCalledWith("t-in", "ls\n");
    expect(resizeTerminal).not.toHaveBeenCalled();
  });

  it("routes a masked JSON resize frame to resizeTerminal with cols/rows", () => {
    const socket = upgrade("t-rs");
    socket.emit("data", clientTextFrame(JSON.stringify({ type: "resize", cols: 120, rows: 40 })));
    expect(resizeTerminal).toHaveBeenCalledWith("t-rs", 120, 40);
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it("falls back to a raw writeTerminal for a non-JSON text frame", () => {
    const socket = upgrade("t-raw");
    socket.emit("data", clientTextFrame("echo hi"));
    expect(writeTerminal).toHaveBeenCalledWith("t-raw", "echo hi");
  });
});
