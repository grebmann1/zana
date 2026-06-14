// Tests for parseYaml with non-object YAML inputs that are technically valid
// YAML but are not schedule objects.
//
// The current implementation guard is:
//   if (parsed == null || typeof parsed !== "object") return null;
//
// Because typeof [] === "object", a top-level YAML array is NOT caught by
// this guard and is returned as-is. This file documents that observed
// behaviour and also pins the null-return paths for YAML scalars that ARE
// caught by typeof, so regressions in either direction are detected.
//
// Callers (store.ts) avoid downstream errors by checking `parsed.id` after
// parseYaml returns, but the function itself carries this subtle gap.
import { describe, it, expect } from "vitest";
import { parseYaml } from "@zana-ai/work/src/scheduling/yaml-format.ts";

describe("parseYaml — YAML scalars return null (typeof guard catches them)", () => {
  it("returns null for a YAML boolean true", () => {
    // typeof true !== "object" → caught by guard
    expect(parseYaml("true")).toBeNull();
  });

  it("returns null for a YAML boolean false", () => {
    expect(parseYaml("false")).toBeNull();
  });

  it("returns null for a YAML integer", () => {
    // typeof 42 !== "object" → caught by guard
    expect(parseYaml("42")).toBeNull();
  });

  it("returns null for a YAML float", () => {
    expect(parseYaml("3.14")).toBeNull();
  });

  it("returns null for the YAML null literal (~)", () => {
    // YAML.parse("~") === null → parsed == null catches it
    expect(parseYaml("~")).toBeNull();
  });

  it("returns null for the YAML null keyword", () => {
    expect(parseYaml("null")).toBeNull();
  });
});

describe("parseYaml — top-level YAML array passes typeof guard and is returned as-is", () => {
  // typeof [] === "object" so the guard does NOT return null for arrays.
  // Callers in store.ts safely handle this by checking `parsed.id` afterward,
  // but the function itself does not normalise arrays to null.
  it("returns the array when YAML parses to a list", () => {
    const result = parseYaml("- a\n- b\n- c");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("returns null-like behaviour for array — .id is undefined (store guard works)", () => {
    // Documents that callers checking `parsed?.id` are safe even when
    // parseYaml returns an array instead of null.
    const result = parseYaml("- id: s1\n  name: test");
    // This produces an array of objects — still an array, not a schedule.
    expect(Array.isArray(result)).toBe(true);
    expect((result as any).id).toBeUndefined();
  });
});
