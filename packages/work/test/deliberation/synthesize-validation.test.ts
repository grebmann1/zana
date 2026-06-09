// Input-validation guard tests for synthesize().
//
// synthesize.ts has three throw guards that are not exercised by any other
// test file:
//   1. `!input || typeof input !== "object"`  → "synthesize: input is required"
//   2. `!input.deliberation || typeof input.deliberation !== "object"`
//                                             → "synthesize: input.deliberation is required"
//   3. `!Array.isArray(input.reviews)`        → "synthesize: input.reviews must be an array"
//
// All three guards fire before the artifact-store write, so no workspace
// context or tmpdir is needed.  Tests are deterministic and pure.

import { describe, it, expect } from "vitest";
import { synthesize } from "@zana-ai/work/src/deliberation/synthesize.ts";

describe("synthesize — input validation guards", () => {
  // ── guard 1: top-level input ────────────────────────────────────────────────

  it("throws 'synthesize: input is required' when called with null", () => {
    expect(() => synthesize(null as any)).toThrow("synthesize: input is required");
  });

  it("throws 'synthesize: input is required' when called with undefined", () => {
    expect(() => synthesize(undefined as any)).toThrow("synthesize: input is required");
  });

  it("throws 'synthesize: input is required' when called with a string", () => {
    expect(() => synthesize("bad" as any)).toThrow("synthesize: input is required");
  });

  it("throws 'synthesize: input is required' when called with a number", () => {
    expect(() => synthesize(42 as any)).toThrow("synthesize: input is required");
  });

  // ── guard 2: input.deliberation ──────────────────────────────────────────────

  it("throws 'synthesize: input.deliberation is required' when deliberation is absent", () => {
    expect(() => synthesize({ reviews: [] } as any)).toThrow(
      "synthesize: input.deliberation is required",
    );
  });

  it("throws 'synthesize: input.deliberation is required' when deliberation is null", () => {
    expect(() => synthesize({ deliberation: null, reviews: [] } as any)).toThrow(
      "synthesize: input.deliberation is required",
    );
  });

  it("throws 'synthesize: input.deliberation is required' when deliberation is a string", () => {
    expect(() => synthesize({ deliberation: "delib-1", reviews: [] } as any)).toThrow(
      "synthesize: input.deliberation is required",
    );
  });

  // ── guard 3: input.reviews ───────────────────────────────────────────────────

  it("throws 'synthesize: input.reviews must be an array' when reviews is a string", () => {
    expect(() =>
      synthesize({ deliberation: { currentRound: 1 }, reviews: "bad" } as any),
    ).toThrow("synthesize: input.reviews must be an array");
  });

  it("throws 'synthesize: input.reviews must be an array' when reviews is null", () => {
    expect(() =>
      synthesize({ deliberation: { currentRound: 1 }, reviews: null } as any),
    ).toThrow("synthesize: input.reviews must be an array");
  });

  it("throws 'synthesize: input.reviews must be an array' when reviews is a plain object", () => {
    expect(() =>
      synthesize({ deliberation: { currentRound: 1 }, reviews: {} } as any),
    ).toThrow("synthesize: input.reviews must be an array");
  });

  it("throws 'synthesize: input.reviews must be an array' when reviews is a number", () => {
    expect(() =>
      synthesize({ deliberation: { currentRound: 1 }, reviews: 3 } as any),
    ).toThrow("synthesize: input.reviews must be an array");
  });
});
