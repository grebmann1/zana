import { describe, it, expect } from "vitest";
import bridge from "../../src/modules/bridge.ts";

/**
 * bridge — lightweight module registry.
 *
 * Tests cover the two public methods: register() and getModule().
 * The module holds shared state, so each test uses a unique ID prefix
 * ("bridge-test-<n>") to avoid cross-test interference without needing
 * a reset mechanism.
 */

describe("getModule()", () => {
  it("returns null for an unknown module id", () => {
    expect(bridge.getModule("bridge-test-unknown-xyz")).toBeNull();
  });

  it("returns null when id has never been registered", () => {
    expect(bridge.getModule("bridge-test-never-registered")).toBeNull();
  });
});

describe("register() + getModule()", () => {
  it("retrieves the exact api object that was registered", () => {
    const api = { doThing: () => 42 };
    bridge.register("bridge-test-1", api);
    expect(bridge.getModule("bridge-test-1")).toBe(api);
  });

  it("retrieves a plain object api", () => {
    const api = { foo: "bar", count: 3 };
    bridge.register("bridge-test-2", api);
    expect(bridge.getModule("bridge-test-2")).toEqual({ foo: "bar", count: 3 });
  });

  it("last-write-wins when the same id is registered twice", () => {
    const first = { version: 1 };
    const second = { version: 2 };
    bridge.register("bridge-test-overwrite", first);
    bridge.register("bridge-test-overwrite", second);
    expect(bridge.getModule("bridge-test-overwrite")).toBe(second);
  });

  it("does not affect unrelated ids when a new module is registered", () => {
    bridge.register("bridge-test-isolation-a", { a: true });
    bridge.register("bridge-test-isolation-b", { b: true });
    expect(bridge.getModule("bridge-test-isolation-a")).toMatchObject({ a: true });
    expect(bridge.getModule("bridge-test-isolation-b")).toMatchObject({ b: true });
  });

  it("stores a module registered with an empty-string id", () => {
    const api = { empty: true };
    bridge.register("", api);
    // getModule uses `|| null`, so a truthy object is returned correctly
    expect(bridge.getModule("")).toBe(api);
  });
});

describe("getModule() falsy-api edge case", () => {
  it("returns null when the registered api is null (falsy || null fallback)", () => {
    bridge.register("bridge-test-null-api", null);
    // null is falsy → getModule returns null via `|| null`
    expect(bridge.getModule("bridge-test-null-api")).toBeNull();
  });

  it("returns null when the registered api is 0 (falsy || null fallback)", () => {
    bridge.register("bridge-test-zero-api", 0);
    expect(bridge.getModule("bridge-test-zero-api")).toBeNull();
  });
});
