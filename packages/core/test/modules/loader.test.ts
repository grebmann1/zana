// loader — module-loader public API surface (read-only / pre-init state).
//
// These tests exercise the exported query functions that operate safely before
// any modules are discovered on disk.  They cover:
//   - getModule()            → null for unknown id
//   - listModules()          → returns an array
//   - handleModuleRoute()    → route-matching + early-exit logic
//   - handleRoute()          → async early-exit when route is unregistered
//
// No calls to init() / shutdown() are made; the loader's global state starts
// empty in a fresh test environment so all lookups safely return null/false.

import { describe, it, expect } from "vitest";

import * as loader from "../../src/modules/loader.ts";

// ---------------------------------------------------------------------------
// getModule
// ---------------------------------------------------------------------------

describe("getModule()", () => {
  it("returns null for an id that was never registered", () => {
    expect(loader.getModule("loader-test-never-registered-xyz")).toBeNull();
  });

  it("returns null for an empty-string id", () => {
    expect(loader.getModule("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listModules
// ---------------------------------------------------------------------------

describe("listModules()", () => {
  it("returns an array", () => {
    expect(Array.isArray(loader.listModules())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleModuleRoute (synchronous)
// ---------------------------------------------------------------------------

describe("handleModuleRoute()", () => {
  it("returns false when pathname does not match /m/<id>/<route>", () => {
    expect(loader.handleModuleRoute("/not-a-module-path", {}, {})).toBe(false);
  });

  it("returns false for the bare root path", () => {
    expect(loader.handleModuleRoute("/", {}, {})).toBe(false);
  });

  it("returns false for /m/<id> with no trailing route segment", () => {
    // Regex requires at least one char after the second slash
    expect(loader.handleModuleRoute("/m/some-mod", {}, {})).toBe(false);
  });

  it("returns false for a well-formed path whose handler is not registered", () => {
    expect(loader.handleModuleRoute("/m/loader-test-mod/some-route", {}, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleRoute (asynchronous)
// ---------------------------------------------------------------------------

describe("handleRoute()", () => {
  it("returns false when the moduleId has no registered route", async () => {
    const req = { method: "GET", url: "/m/loader-test-mod/foo" } as any;
    const res = {} as any;
    const result = await loader.handleRoute("loader-test-mod", "/foo", req, res);
    expect(result).toBe(false);
  });

  it("returns false for an unregistered nested route path", async () => {
    const req = { method: "GET", url: "/m/loader-test-mod/a/b/c" } as any;
    const res = {} as any;
    const result = await loader.handleRoute("loader-test-mod", "/a/b/c", req, res);
    expect(result).toBe(false);
  });
});
