// Focused tests for the input-validation guards in propose() — run.ts lines 219-228.
//
// All three guards throw BEFORE any file I/O or workspace interaction, so these
// tests are truly pure: no tmp directory, no workspaceContext.init(), no
// checkpointStore.init() required.  They cover the branches that run.test.ts
// intentionally skips because the main suite focuses on successful flows.
//
// Guards exercised here:
//   1. null / non-object input → "propose: input is required"
//   2. missing / empty / whitespace-only question → "propose: question is required"
//   3. non-string promptSnapshot → "propose: promptSnapshot is required"

import { describe, it, expect } from "vitest";
import { propose } from "@zana-ai/work/src/deliberation/run.ts";

// ---------------------------------------------------------------------------
// Guard 1 — input must be a non-null object
// ---------------------------------------------------------------------------

describe("propose() — input guard (null / non-object input)", () => {
  it("throws when called with null", () => {
    expect(() => propose(null as any)).toThrow("propose: input is required");
  });

  it("throws when called with undefined", () => {
    expect(() => propose(undefined as any)).toThrow("propose: input is required");
  });

  it("throws when called with a primitive string", () => {
    expect(() => propose("question?" as any)).toThrow("propose: input is required");
  });

  it("throws when called with a number", () => {
    expect(() => propose(42 as any)).toThrow("propose: input is required");
  });
});

// ---------------------------------------------------------------------------
// Guard 2 — question must be a non-empty, non-whitespace-only string
// ---------------------------------------------------------------------------

describe("propose() — question guard (missing / empty / whitespace)", () => {
  const base = { voters: [{ profileId: "a" }], promptSnapshot: "p" };

  it("throws when question is missing from input object", () => {
    expect(() => propose({ ...base } as any)).toThrow("propose: question is required");
  });

  it("throws when question is an empty string", () => {
    expect(() => propose({ ...base, question: "" })).toThrow("propose: question is required");
  });

  it("throws when question is a whitespace-only string", () => {
    expect(() => propose({ ...base, question: "   " })).toThrow("propose: question is required");
    expect(() => propose({ ...base, question: "\t\n" })).toThrow("propose: question is required");
  });

  it("throws when question is null", () => {
    expect(() => propose({ ...base, question: null as any })).toThrow(
      "propose: question is required",
    );
  });

  it("throws when question is a number", () => {
    expect(() => propose({ ...base, question: 7 as any })).toThrow(
      "propose: question is required",
    );
  });
});

// ---------------------------------------------------------------------------
// Guard 3 — promptSnapshot must be a string
// ---------------------------------------------------------------------------

describe("propose() — promptSnapshot guard (non-string values)", () => {
  const base = { question: "Is this safe?", voters: [{ profileId: "a" }] };

  it("throws when promptSnapshot is missing", () => {
    expect(() => propose({ ...base } as any)).toThrow("propose: promptSnapshot is required");
  });

  it("throws when promptSnapshot is null", () => {
    expect(() => propose({ ...base, promptSnapshot: null as any })).toThrow(
      "propose: promptSnapshot is required",
    );
  });

  it("throws when promptSnapshot is a number", () => {
    expect(() => propose({ ...base, promptSnapshot: 42 as any })).toThrow(
      "propose: promptSnapshot is required",
    );
  });

  it("throws when promptSnapshot is an object", () => {
    expect(() => propose({ ...base, promptSnapshot: {} as any })).toThrow(
      "propose: promptSnapshot is required",
    );
  });

  it("does NOT throw for an empty-string promptSnapshot (empty string is valid)", () => {
    // The guard only checks `typeof !== "string"`. An empty string passes the
    // type check — the caller is responsible for meaningful content.
    // NOTE: this call WILL throw further downstream (workspace not initialized),
    // so we only assert the guard itself does not fire.
    let threw: any;
    try {
      propose({ ...base, promptSnapshot: "" });
    } catch (e: any) {
      threw = e;
    }
    // The error must NOT be the promptSnapshot guard.
    if (threw) {
      expect(threw.message).not.toContain("promptSnapshot is required");
    }
  });
});
