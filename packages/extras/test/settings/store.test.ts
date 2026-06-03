// Tests for the pure helper functions exported from extras/src/settings/store.ts.
// These functions are all IO-free, so no mocking of core or fs is needed.
import { describe, it, expect } from "vitest";

import {
  isPlainObject,
  deepMerge,
  validate,
  providerFromModel,
  getEnvForProvider,
} from "@zana-ai/extras/src/settings/store.ts";

// ── isPlainObject ────────────────────────────────────────────────────────────

describe("isPlainObject", () => {
  it("returns true for a plain object literal", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("returns true for an empty object", () => {
    expect(isPlainObject({})).toBe(true);
  });

  it("returns false for null", () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it("returns false for an array", () => {
    expect(isPlainObject([])).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isPlainObject("hello")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isPlainObject(42)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPlainObject(undefined)).toBe(false);
  });
});

// ── deepMerge ────────────────────────────────────────────────────────────────

describe("deepMerge", () => {
  it("merges two flat objects without mutating either input", () => {
    const base = { a: 1, b: 2 };
    const patch = { b: 99, c: 3 };
    const result = deepMerge(base, patch);
    expect(result).toEqual({ a: 1, b: 99, c: 3 });
    expect(base).toEqual({ a: 1, b: 2 });   // unchanged
    expect(patch).toEqual({ b: 99, c: 3 }); // unchanged
  });

  it("recursively merges nested objects", () => {
    const base = { llm: { providers: { anthropic: { apiKey: "k1" } } } };
    const patch = { llm: { providers: { openai: { apiKey: "k2" } } } };
    expect(deepMerge(base, patch)).toEqual({
      llm: { providers: { anthropic: { apiKey: "k1" }, openai: { apiKey: "k2" } } },
    });
  });

  it("patch leaf value overrides base leaf (non-object wins)", () => {
    const base = { a: { b: 1 } };
    const patch = { a: "string-override" };
    expect(deepMerge(base, patch)).toEqual({ a: "string-override" });
  });

  it("returns patch unchanged when base is not a plain object", () => {
    expect(deepMerge("not-an-object", { x: 1 })).toEqual({ x: 1 });
    expect(deepMerge(null, { x: 1 })).toEqual({ x: 1 });
  });

  it("handles empty patch (returns clone of base)", () => {
    expect(deepMerge({ a: 1 }, {})).toEqual({ a: 1 });
  });
});

// ── validate ─────────────────────────────────────────────────────────────────

describe("validate", () => {
  it("returns null for a valid minimal settings object", () => {
    expect(validate({})).toBeNull();
  });

  it("returns null for a valid object with llm providers", () => {
    expect(validate({ llm: { providers: { anthropic: { apiKey: "x" } } } })).toBeNull();
  });

  it("returns null for a valid object with defaultProvider", () => {
    expect(validate({ llm: { defaultProvider: "anthropic" } })).toBeNull();
  });

  it("returns null when defaultProvider is null (clearing default)", () => {
    expect(validate({ llm: { defaultProvider: null } })).toBeNull();
  });

  it("returns null for unknown top-level keys (open schema)", () => {
    expect(validate({ unknownKey: "allowed" })).toBeNull();
  });

  it("returns error string when input is not an object", () => {
    expect(validate("bad")).toBeTruthy();
    expect(validate(42)).toBeTruthy();
    expect(validate(null)).toBeTruthy();
  });

  it("returns error string when llm is not an object", () => {
    expect(validate({ llm: "bad" })).toBeTruthy();
  });

  it("returns error string when llm.providers is not an object", () => {
    expect(validate({ llm: { providers: "bad" } })).toBeTruthy();
  });

  it("returns error string when llm.defaultProvider is not a string or null", () => {
    expect(validate({ llm: { defaultProvider: 42 } })).toBeTruthy();
  });

  it("returns error string when plugins is not an object", () => {
    expect(validate({ plugins: "nope" })).toBeTruthy();
  });
});

// ── providerFromModel ─────────────────────────────────────────────────────────

describe("providerFromModel", () => {
  it("returns null for falsy input", () => {
    expect(providerFromModel(null)).toBeNull();
    expect(providerFromModel("")).toBeNull();
    expect(providerFromModel(undefined)).toBeNull();
  });

  it("maps claude prefix to anthropic", () => {
    expect(providerFromModel("claude-3-5-sonnet-20241022")).toBe("anthropic");
  });

  it("maps short alias 'opus' to anthropic", () => {
    expect(providerFromModel("opus")).toBe("anthropic");
  });

  it("maps short alias 'sonnet' to anthropic", () => {
    expect(providerFromModel("sonnet")).toBe("anthropic");
  });

  it("maps short alias 'haiku' to anthropic", () => {
    expect(providerFromModel("haiku")).toBe("anthropic");
  });

  it("maps us.anthropic. prefix to sfdc-gateway", () => {
    expect(providerFromModel("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("sfdc-gateway");
  });

  it("maps gpt prefix to openai", () => {
    expect(providerFromModel("gpt-4o")).toBe("openai");
  });

  it("maps o1 prefix to openai", () => {
    expect(providerFromModel("o1-preview")).toBe("openai");
  });

  it("maps o3 prefix to openai", () => {
    expect(providerFromModel("o3-mini")).toBe("openai");
  });

  it("maps gemini prefix to google", () => {
    expect(providerFromModel("gemini-2.0-flash")).toBe("google");
  });

  it("returns null for an unknown model id", () => {
    expect(providerFromModel("some-unknown-model-xyz")).toBeNull();
  });
});

// ── getEnvForProvider ─────────────────────────────────────────────────────────

describe("getEnvForProvider", () => {
  it("returns empty object for falsy providerId", () => {
    expect(getEnvForProvider(null)).toEqual({});
    expect(getEnvForProvider("")).toEqual({});
  });

  it("returns empty object for unknown provider with no config registered", () => {
    // providers are loaded from real settings on disk — but getEnvForProvider
    // receives the provider config as part of getLlmProviders(). Here we call
    // it directly with a providerId that is not in the live settings.
    // Because the live settings on this machine have no providers configured,
    // the function returns {}.
    // We cannot fully unit-test the disk path without mocking, so we only
    // cover the guarding branches here (no config → empty).
    expect(getEnvForProvider("nonexistent-provider-xyz")).toEqual({});
  });
});
