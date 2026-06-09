// Focused edge-case tests for `canonicalize()` in synthesize.ts.
//
// The main synthesize.test.ts exercises the happy path — two object inputs
// with out-of-order keys produce identical bytes.  The branches that remain
// uncovered are:
//   - primitive top-level values (string, number, boolean)
//   - null (passes the `value === null` guard in canonicalValue)
//   - empty object / empty array
//   - arrays containing null and primitive values
//   - deeply-nested mixed structures
//
// All tests are pure — no workspace context, no disk I/O.

import { describe, it, expect } from "vitest";
import { canonicalize } from "@zana-ai/work/src/deliberation/synthesize.ts";

describe("canonicalize — primitive and null top-level values", () => {
  it("serialises null as the JSON literal 'null'", () => {
    expect(canonicalize(null)).toBe("null");
  });

  it("serialises a string value with JSON quoting", () => {
    expect(canonicalize("hello")).toBe('"hello"');
  });

  it("serialises a number value", () => {
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(-3.14)).toBe("-3.14");
  });

  it("serialises boolean values", () => {
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });
});

describe("canonicalize — empty containers", () => {
  it("serialises an empty object as '{}'", () => {
    expect(canonicalize({})).toBe("{}");
  });

  it("serialises an empty array as '[]'", () => {
    expect(canonicalize([])).toBe("[]");
  });
});

describe("canonicalize — arrays with nulls and primitives", () => {
  it("preserves null elements inside an array", () => {
    expect(canonicalize([null, null])).toBe("[null,null]");
  });

  it("preserves primitive elements inside an array", () => {
    expect(canonicalize([1, "two", true, null])).toBe('[1,"two",true,null]');
  });

  it("arrays preserve insertion order (semantic — NOT sorted)", () => {
    // Key invariant: unlike object keys, array element order is never changed.
    const a = canonicalize([3, 1, 2]);
    const b = canonicalize([1, 2, 3]);
    expect(a).not.toBe(b);
    expect(a).toBe("[3,1,2]");
  });
});

describe("canonicalize — objects with null values", () => {
  it("serialises object fields whose value is null", () => {
    const out = canonicalize({ b: null, a: "x" });
    // Keys must be sorted: a before b.
    expect(out).toBe('{"a":"x","b":null}');
  });
});

describe("canonicalize — deeply-nested and mixed structures", () => {
  it("sorts keys at every nesting level, not just the top level", () => {
    const value = { z: { y: [{ b: 1, a: 2 }], x: null }, m: true };
    const out = canonicalize(value);
    const parsed = JSON.parse(out);

    // Top-level keys: m, z (alphabetical).
    expect(Object.keys(parsed)).toEqual(["m", "z"]);
    // Nested keys in value.z: x, y (alphabetical).
    expect(Object.keys(parsed.z)).toEqual(["x", "y"]);
    // Object inside the nested array: a, b (alphabetical).
    expect(Object.keys(parsed.z.y[0])).toEqual(["a", "b"]);
  });

  it("produces identical output for structurally equal inputs regardless of construction order", () => {
    const v1 = { z: 3, a: { y: 2, x: 1 }, m: [{ b: "two", a: "one" }] };
    const v2 = { m: [{ a: "one", b: "two" }], a: { x: 1, y: 2 }, z: 3 };
    expect(canonicalize(v1)).toBe(canonicalize(v2));
  });

  it("round-trips: JSON.parse(canonicalize(v)) deep-equals v", () => {
    const original = { id: "d-1", tally: { approve: 2, changes: 1 }, ts: "2026-01-01T00:00:00.000Z" };
    const restored = JSON.parse(canonicalize(original));
    expect(restored).toEqual(original);
  });
});
