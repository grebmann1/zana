// Unit tests for packages/core/src/guardrails/index.ts
// Focuses on resolveGuardrails — pure config-to-guardrail mapping, no I/O.

import { describe, it, expect, vi } from "vitest";
import { resolveGuardrails } from "../../src/guardrails/index.ts";

describe("resolveGuardrails", () => {
  it("returns empty array for null input", () => {
    expect(resolveGuardrails(null)).toEqual([]);
  });

  it("returns empty array for undefined input", () => {
    expect(resolveGuardrails(undefined)).toEqual([]);
  });

  it("returns empty array for empty array input", () => {
    expect(resolveGuardrails([])).toEqual([]);
  });

  it("passes through an object that already has a validate function", () => {
    const custom = { id: "custom", validate: vi.fn(() => ({ pass: true })) };
    const result = resolveGuardrails([custom]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(custom);
  });

  it("resolves json-parse type to a guardrail with an id", () => {
    const result = resolveGuardrails([{ type: "json-parse" }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("json-parse");
    expect(typeof result[0].validate).toBe("function");
  });

  it("resolves json-schema type to a guardrail", () => {
    const result = resolveGuardrails([{ type: "json-schema", schema: null }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("json-schema");
    expect(typeof result[0].validate).toBe("function");
  });

  it("resolves no-secrets type to a guardrail", () => {
    const result = resolveGuardrails([{ type: "no-secrets" }]);
    expect(result).toHaveLength(1);
    expect(typeof result[0].validate).toBe("function");
  });

  it("resolves max-length type with default maxChars", () => {
    const result = resolveGuardrails([{ type: "max-length" }]);
    expect(result).toHaveLength(1);
    expect(typeof result[0].validate).toBe("function");
    // Should pass for a short string
    expect(result[0].validate("hello").pass).toBe(true);
  });

  it("resolves max-length type with custom maxChars", () => {
    const result = resolveGuardrails([{ type: "max-length", maxChars: 5 }]);
    expect(result).toHaveLength(1);
    expect(result[0].validate("hi").pass).toBe(true);
    expect(result[0].validate("toolongstring").pass).toBe(false);
  });

  it("resolves contains-pattern type to a guardrail", () => {
    const result = resolveGuardrails([{ type: "contains-pattern", pattern: "hello", description: "must say hello" }]);
    expect(result).toHaveLength(1);
    expect(typeof result[0].validate).toBe("function");
    expect(result[0].validate("hello world").pass).toBe(true);
    expect(result[0].validate("goodbye world").pass).toBe(false);
  });

  it("filters out unknown guardrail types (returns empty array)", () => {
    const result = resolveGuardrails([{ type: "nonexistent-type" }]);
    expect(result).toEqual([]);
  });

  it("filters out plain objects with no type and no validate function", () => {
    const result = resolveGuardrails([{ someRandomKey: 42 }]);
    expect(result).toEqual([]);
  });

  it("handles a mixed array — valid entries kept, unknowns dropped", () => {
    const configs = [
      { type: "json-parse" },
      { type: "unknown-xyz" },
      { id: "inline", validate: () => ({ pass: true }) },
    ];
    const result = resolveGuardrails(configs);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("json-parse");
    expect(result[1].id).toBe("inline");
  });
});
