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

// ---------------------------------------------------------------------------
// enableModule / disableModule — guard rails
//
// Both must fail safely before mutating any global state when handed an id
// they cannot resolve. enableModule() returns false when the id is not present
// on disk (no module.json found); disableModule() returns false when the id was
// never loaded into the in-memory registry. Neither path calls init() or the
// workspace lock, so both are fully deterministic in a fresh test environment.
// ---------------------------------------------------------------------------

describe("enableModule()", () => {
  it("returns false for a module id that is not present on disk", async () => {
    await expect(
      loader.enableModule("loader-test-never-on-disk-xyz"),
    ).resolves.toBe(false);
    // The failed enable must not leave a phantom record behind.
    expect(loader.getModule("loader-test-never-on-disk-xyz")).toBeNull();
  });
});

describe("disableModule()", () => {
  it("returns false for a module that was never loaded", async () => {
    await expect(
      loader.disableModule("loader-test-never-loaded-xyz"),
    ).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// safe-before-init contracts
//
// shutdown() must be an idempotent no-op when init() was never called (the
// `if (!initialized) return` guard), and handleRoute() must short-circuit on
// an unregistered route BEFORE it injects res.json or parses req.body/query.
// The body-parse path calls req.on(...) — passing a plain object with no .on
// would throw if the registry guard did not run first, so a POST with a bare
// req/res object pins that ordering. No init()/shutdown() side effects, no fs,
// no timers — fully deterministic in a fresh per-file loader state.
// ---------------------------------------------------------------------------

describe("loader — safe-before-init contracts", () => {
  it("shutdown() is a no-op that resolves when never initialized", async () => {
    await expect(loader.shutdown()).resolves.toBeUndefined();
  });

  it("handleRoute() returns false without mutating req/res for an unregistered POST route", async () => {
    const req = { method: "POST", url: "/m/loader-test-mod/x" } as any;
    const res = {} as any;
    const result = await loader.handleRoute("loader-test-mod", "/x", req, res);
    expect(result).toBe(false);
    // Registry guard short-circuits before res.json injection and body parsing.
    expect(res.json).toBeUndefined();
    expect(req.body).toBeUndefined();
    expect(req.query).toBeUndefined();
  });
});
