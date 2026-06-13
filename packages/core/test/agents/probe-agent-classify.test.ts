import { describe, it, expect } from "vitest";
import { classifySpawnError } from "@zana-ai/core/src/agents/probe-agent.ts";

/**
 * Unit tests for classifySpawnError — the spawn-path error → retry-policy
 * bucket classifier (FU-T3a-3). Pure function, no I/O: we assert the
 * documented bucketing contract, the most-specific-first ordering, and the
 * additive "spawn" fall-through for anything unrecognized.
 */
describe("classifySpawnError", () => {
  it("buckets auth failures (401/403, forbidden, invalid token)", () => {
    expect(classifySpawnError("HTTP 401 Unauthorized")).toBe("auth");
    expect(classifySpawnError("403 forbidden")).toBe("auth");
    expect(classifySpawnError("invalid-token supplied")).toBe("auth");
  });

  it("buckets rate-limit failures (429, too many requests)", () => {
    expect(classifySpawnError("429 rate limit exceeded")).toBe("rate_limit");
    expect(classifySpawnError("Too Many Requests")).toBe("rate_limit");
  });

  it("buckets quota failures (402, quota exhausted, usage limit)", () => {
    expect(classifySpawnError("402 payment required")).toBe("quota");
    expect(classifySpawnError("monthly quota exhausted")).toBe("quota");
    expect(classifySpawnError("usage limit reached")).toBe("quota");
  });

  it("buckets transport failures (DNS, refused, reset, TLS)", () => {
    expect(classifySpawnError("ENOTFOUND api.example.com")).toBe("transport");
    expect(classifySpawnError("connect ECONNREFUSED")).toBe("transport");
    expect(classifySpawnError("ECONNRESET")).toBe("transport");
    expect(classifySpawnError("certificate has expired")).toBe("transport");
  });

  it("matches the most specific bucket first: auth wins over transport", () => {
    // Documented invariant: "TLS 401 cert error" → auth (creds rejected),
    // not transport, because auth is checked before transport.
    expect(classifySpawnError("TLS 401 cert error")).toBe("auth");
  });

  it("falls through to legacy 'spawn' for unrecognized / process-level errors", () => {
    expect(classifySpawnError("ENOENT: binary not found")).toBe("spawn");
    expect(classifySpawnError("something totally unexpected")).toBe("spawn");
  });

  it("returns 'spawn' for empty / null / undefined input", () => {
    expect(classifySpawnError("")).toBe("spawn");
    expect(classifySpawnError(null)).toBe("spawn");
    expect(classifySpawnError(undefined)).toBe("spawn");
  });

  it("classifies Error objects by their message", () => {
    expect(classifySpawnError(new Error("429 slow down"))).toBe("rate_limit");
  });

  it("classifies objects with a `code` field (e.g. Node sys errors)", () => {
    expect(classifySpawnError({ code: "ECONNREFUSED", message: "connect failed" })).toBe(
      "transport",
    );
  });
});
