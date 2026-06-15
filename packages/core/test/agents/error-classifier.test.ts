// Unit tests for the dependency-free error-classifier shared by probe-agent
// and lifecycle's transient-error retry loop. Focuses on the retry-policy
// surface added for the resume work: 529/overload bucketing and the
// transient-vs-structural split that gates whether a failed worker is retried.

import { describe, it, expect } from "vitest";
import {
  classifySpawnError,
  isTransientFailure,
} from "@zana-ai/core/src/agents/error-classifier.ts";

describe("classifySpawnError — overload (529)", () => {
  it("buckets a 529 status as rate_limit (transient backpressure)", () => {
    expect(classifySpawnError("API error 529")).toBe("rate_limit");
    expect(classifySpawnError("Error: 529 Overloaded")).toBe("rate_limit");
  });

  it("buckets the word 'overloaded' as rate_limit even without a code", () => {
    expect(classifySpawnError("the service is Overloaded, try again")).toBe("rate_limit");
  });

  it("still buckets 429 / rate-limit phrasing as rate_limit", () => {
    expect(classifySpawnError("429 Too Many Requests")).toBe("rate_limit");
    expect(classifySpawnError("rate limit exceeded")).toBe("rate_limit");
  });
});

describe("isTransientFailure — retry gate", () => {
  it("treats rate_limit and transport as transient (retryable)", () => {
    expect(isTransientFailure("rate_limit")).toBe(true);
    expect(isTransientFailure("transport")).toBe(true);
  });

  it("treats structural failures as NOT transient (no retry)", () => {
    expect(isTransientFailure("auth")).toBe(false);
    expect(isTransientFailure("quota")).toBe(false);
    expect(isTransientFailure("misconfig")).toBe(false);
    expect(isTransientFailure("validation")).toBe(false);
    expect(isTransientFailure("timeout")).toBe(false);
  });

  it("does NOT retry the unknown 'spawn' bucket — we don't auto-retry the unexplained", () => {
    expect(isTransientFailure("spawn")).toBe(false);
  });

  it("end-to-end: a 529 overload message classifies as a retryable failure", () => {
    expect(isTransientFailure(classifySpawnError("529 Overloaded"))).toBe(true);
  });

  it("end-to-end: a 401 auth message classifies as NOT retryable", () => {
    expect(isTransientFailure(classifySpawnError("HTTP 401 Unauthorized"))).toBe(false);
  });
});
