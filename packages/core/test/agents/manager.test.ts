// Unit tests for the pure/exported helpers in agents/manager.ts.
// Specifically:
//   • classifySpawnError  — error-message → ProbeFailureKind classifier
//   • _testSpawnOverloadProbe + _resetSpawnOverloadState — spawn-overload
//     streak counter (explicitly exported for tests)
//
// No real spawning, no real PTY, no network — all deterministic.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// classifySpawnError + the spawn-overload probe are pure helpers — they do
// not read modules/config or workspace state, so the test runs against the
// real (post-split) manager facade with no internal mocks.
// Import from the built dist — the facade lazily `require()`s sibling modules
// via raw CJS, which only resolves cleanly against compiled .js files.
// (The vite SSR runner can't resolve relative `require("../project/...")`
// inside .ts source files.)
import * as core from "@zana-ai/core";
const {
  classifySpawnError,
  _testSpawnOverloadProbe,
  _resetSpawnOverloadState,
} = (core as any).agents.manager;
const workspaceContext: any = (core as any).project.workspaceContext;

// `getSpawnThrottleStreakLimit` reads modules/config.get(), which lazy-requires
// project/workspace-context for its config path. Initialise a tmp workspace
// once so the whole suite can read defaults without a fake module.
let tmpWs: string;

beforeAll(() => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "zana-manager-test-"));
  fs.mkdirSync(path.join(tmpWs, ".zana"), { recursive: true });
  workspaceContext.init(tmpWs);
});

afterAll(() => {
  try { (workspaceContext as any)._resetForTesting?.(); } catch {}
  try { fs.rmSync(tmpWs, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// classifySpawnError
// ---------------------------------------------------------------------------

describe("classifySpawnError", () => {
  it("returns 'spawn' for null / undefined input", () => {
    expect(classifySpawnError(null)).toBe("spawn");
    expect(classifySpawnError(undefined)).toBe("spawn");
  });

  it("returns 'spawn' for empty string", () => {
    expect(classifySpawnError("")).toBe("spawn");
  });

  it("classifies 401 status as auth", () => {
    expect(classifySpawnError("HTTP 401 Unauthorized")).toBe("auth");
  });

  it("classifies 403 status as auth", () => {
    expect(classifySpawnError("request failed: 403 Forbidden")).toBe("auth");
  });

  it("classifies 'unauthor' substring as auth (case-insensitive)", () => {
    expect(classifySpawnError("Unauthorized access")).toBe("auth");
    expect(classifySpawnError("unauthorized")).toBe("auth");
  });

  it("classifies 'forbidden' as auth", () => {
    expect(classifySpawnError("forbidden")).toBe("auth");
  });

  it("classifies 'invalid_token' variants as auth", () => {
    expect(classifySpawnError("invalid-token")).toBe("auth");
    expect(classifySpawnError("invalid token supplied")).toBe("auth");
  });

  it("classifies 429 status as rate_limit", () => {
    expect(classifySpawnError("HTTP 429 Too Many Requests")).toBe("rate_limit");
  });

  it("classifies 'rate limit' / 'rate-limit' as rate_limit", () => {
    expect(classifySpawnError("rate limit exceeded")).toBe("rate_limit");
    expect(classifySpawnError("rate-limit hit")).toBe("rate_limit");
  });

  it("classifies 'too many requests' as rate_limit", () => {
    expect(classifySpawnError("too many requests")).toBe("rate_limit");
  });

  it("classifies 402 status as quota", () => {
    expect(classifySpawnError("402 payment required")).toBe("quota");
  });

  it("classifies 'quota' substring as quota", () => {
    expect(classifySpawnError("quota exhausted")).toBe("quota");
  });

  it("classifies 'usage_limit' as quota", () => {
    expect(classifySpawnError("usage-limit reached")).toBe("quota");
  });

  it("classifies ENOTFOUND as transport", () => {
    expect(classifySpawnError("getaddrinfo ENOTFOUND api.anthropic.com")).toBe("transport");
  });

  it("classifies ECONNREFUSED as transport", () => {
    expect(classifySpawnError("connect ECONNREFUSED 127.0.0.1:443")).toBe("transport");
  });

  it("classifies ECONNRESET as transport", () => {
    expect(classifySpawnError("read ECONNRESET")).toBe("transport");
  });

  it("classifies ETIMEDOUT as transport", () => {
    expect(classifySpawnError("connect ETIMEDOUT")).toBe("transport");
  });

  it("classifies TLS/certificate errors as transport", () => {
    expect(classifySpawnError("TLS handshake failed")).toBe("transport");
    expect(classifySpawnError("self-signed certificate in chain")).toBe("transport");
    expect(classifySpawnError("SSL_ERROR_RX_RECORD_TOO_LONG")).toBe("transport");
  });

  it("classifies an unrecognized message as spawn (legacy bucket)", () => {
    expect(classifySpawnError("something went wrong")).toBe("spawn");
    expect(classifySpawnError("ENOENT /usr/local/bin/claude")).toBe("spawn");
  });

  it("accepts an Error object and extracts .message", () => {
    const err = new Error("429 Too Many Requests");
    expect(classifySpawnError(err)).toBe("rate_limit");
  });

  it("accepts an object with .code + .message, code wins when more specific", () => {
    const err = { code: "ECONNREFUSED", message: "something mundane" };
    expect(classifySpawnError(err)).toBe("transport");
  });

  it("falls back to .message when .code does not match a bucket", () => {
    const err = { code: "GENERIC_ERROR", message: "HTTP 401 unauthorized" };
    expect(classifySpawnError(err)).toBe("auth");
  });

  // auth before transport: "TLS 401" → auth (more specific wins)
  it("prefers auth over transport when both signals are in the same message", () => {
    expect(classifySpawnError("TLS 401 cert error")).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// Spawn-overload streak counter (_testSpawnOverloadProbe)
// ---------------------------------------------------------------------------

describe("spawn-overload streak counter", () => {
  beforeEach(() => {
    _resetSpawnOverloadState();
  });

  it("record increments the streak and returns the new count", () => {
    expect(_testSpawnOverloadProbe("record", "parent-1")).toBe(1);
    expect(_testSpawnOverloadProbe("record", "parent-1")).toBe(2);
    expect(_testSpawnOverloadProbe("record", "parent-1")).toBe(3);
  });

  it("streaks are tracked independently per parent", () => {
    _testSpawnOverloadProbe("record", "p1");
    _testSpawnOverloadProbe("record", "p1");
    _testSpawnOverloadProbe("record", "p2");

    // p1 streak is 2; p2 streak is 1 — independent
    expect(_testSpawnOverloadProbe("record", "p1")).toBe(3);
    expect(_testSpawnOverloadProbe("record", "p2")).toBe(2);
  });

  it("clear resets the streak for the given parent", () => {
    _testSpawnOverloadProbe("record", "parent-A");
    _testSpawnOverloadProbe("record", "parent-A");
    _testSpawnOverloadProbe("clear", "parent-A");

    // After clearing, next record starts fresh at 1
    expect(_testSpawnOverloadProbe("record", "parent-A")).toBe(1);
  });

  it("clear does not affect other parents", () => {
    _testSpawnOverloadProbe("record", "p1");
    _testSpawnOverloadProbe("record", "p1");
    _testSpawnOverloadProbe("record", "p2");
    _testSpawnOverloadProbe("clear", "p1");

    // p2 streak is unaffected
    expect(_testSpawnOverloadProbe("record", "p2")).toBe(2);
  });

  it("null parentAgentId is treated as the top-level '' key", () => {
    expect(_testSpawnOverloadProbe("record", null)).toBe(1);
    expect(_testSpawnOverloadProbe("record", null)).toBe(2);
    _testSpawnOverloadProbe("clear", null);
    expect(_testSpawnOverloadProbe("record", null)).toBe(1);
  });

  it("limit returns the configured streak limit (default 5)", () => {
    const limit = _testSpawnOverloadProbe("limit");
    expect(typeof limit).toBe("number");
    expect(limit).toBeGreaterThan(0);
  });

  it("_resetSpawnOverloadState clears all parents at once", () => {
    _testSpawnOverloadProbe("record", "x");
    _testSpawnOverloadProbe("record", "y");
    _resetSpawnOverloadState();
    // Both should start from 1 again
    expect(_testSpawnOverloadProbe("record", "x")).toBe(1);
    expect(_testSpawnOverloadProbe("record", "y")).toBe(1);
  });
});
