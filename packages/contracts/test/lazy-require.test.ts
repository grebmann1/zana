import { describe, it, expect, vi } from "vitest";
import { lazyRequire } from "../src/lazy-require.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake module object and return a getter spy that also records calls */
function fakeModule<T extends object>(shape: T): { mod: T; getter: () => T; callCount: () => number } {
  let count = 0;
  const getter = () => {
    count++;
    return shape;
  };
  return { mod: shape, getter, callCount: () => count };
}

// ---------------------------------------------------------------------------
// String-path overload (module-name form)
// ---------------------------------------------------------------------------

describe("lazyRequire — string path overload", () => {
  it("proxies property access to the required module", () => {
    // We can't easily override require() in vitest without mocking the whole
    // module system.  Instead we use the getter overload for behaviour tests
    // and only verify the string branch invokes require() at all via an
    // integration-style check against a real built-in.
    const path = lazyRequire<typeof import("path")>("path");
    expect(typeof path.join).toBe("function");
    expect(path.join("a", "b")).toBe("a/b");
  });

  it("does not call require() until a property is accessed", () => {
    // Because require() is not interceptable without heavy mocking we rely on
    // the getter overload to assert the lazy-evaluation contract (see below).
    // This test simply checks the proxy is returned synchronously.
    const proxy = lazyRequire<{ x: number }>(
      () => ({ x: 42 }) // getter overload, same lazy guarantee
    );
    // Proxy object exists before we touch it
    expect(proxy).toBeDefined();
  });

  // The lazy-evaluation contract for the STRING branch is otherwise untested:
  // the suite above only proves the getter overload defers resolution. Yet the
  // whole reason this helper exists (break the core/work/extras require-cycle at
  // load time) hinges on the string branch NOT calling require() until first
  // property access — lazy-require.ts resolve() runs `require(target)` only
  // inside a trap. A bad module path is the cleanest probe: constructing the
  // proxy must NOT throw (require deferred), and the MODULE_NOT_FOUND must
  // surface only when a property is actually touched. Pins that a regression
  // eagerly resolving the string branch (re-introducing the cycle) is caught.
  it("string-path overload defers require() until first access (bad path throws only on access)", () => {
    let proxy: Record<string, unknown>;
    // Construction must be side-effect-free even for an unresolvable module.
    expect(() => {
      proxy = lazyRequire<Record<string, unknown>>(
        "definitely-not-a-real-module-zzz-9f3a",
      );
    }).not.toThrow();
    // require() fires (and fails) only when a property is read through a trap.
    expect(() => proxy!.anything).toThrow(/Cannot find module|definitely-not-a-real-module/);
  });

  // The string-path overload is otherwise only exercised through the `get` trap
  // (path.join above). The remaining traps — `has` and `ownKeys` — each resolve
  // the module via the SAME deferred require() but were only proven for the
  // getter overload. A regression that wired a non-`get` trap on the string
  // branch to the wrong target (or skipped resolution) would pass every other
  // string-path test. This pins that the `in` operator and key enumeration both
  // reflect into the real required module (built-in `path`, fully deterministic).
  it("string-path overload reflects `in` and ownKeys into the required module", () => {
    const path = lazyRequire<typeof import("path")>("path");
    // `has` trap → `"join" in require("path")`
    expect("join" in path).toBe(true);
    expect("definitelyNotAPathExport" in path).toBe(false);
    // `ownKeys` trap → Reflect.ownKeys(require("path"))
    expect(Reflect.ownKeys(path)).toContain("join");
  });

  // The fourth trap — getOwnPropertyDescriptor — is the only one never
  // exercised on the STRING branch (get/has/ownKeys are pinned above; the
  // getter overload pins this trap separately). It must reflect into the
  // deferred require() target like the others. A regression that left this
  // trap pointing at the empty Proxy target (instead of resolve()) would
  // return undefined for a real export yet pass every other string-path test.
  // Built-in `path` keeps it fully deterministic.
  it("string-path overload reflects getOwnPropertyDescriptor into the required module", () => {
    const path = lazyRequire<typeof import("path")>("path");
    const desc = Object.getOwnPropertyDescriptor(path, "join");
    expect(desc).toBeDefined();
    expect(typeof desc?.value).toBe("function");
    // A non-existent export has no descriptor.
    expect(Object.getOwnPropertyDescriptor(path, "definitelyNotAPathExport")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Getter overload
// ---------------------------------------------------------------------------

describe("lazyRequire — getter overload", () => {
  it("returns the value of the named property", () => {
    const { getter } = fakeModule({ answer: 42 });
    const proxy = lazyRequire(getter);
    expect(proxy.answer).toBe(42);
  });

  it("proxies multiple properties", () => {
    const { getter } = fakeModule({ a: 1, b: "two", c: true });
    const proxy = lazyRequire(getter);
    expect(proxy.a).toBe(1);
    expect(proxy.b).toBe("two");
    expect(proxy.c).toBe(true);
  });

  it("resolves the getter exactly once (caches on first access)", () => {
    const { getter, callCount } = fakeModule({ v: 99 });
    const proxy = lazyRequire(getter);
    expect(callCount()).toBe(0); // not yet called
    const _ = proxy.v;
    const __ = proxy.v; // second access
    expect(callCount()).toBe(1); // still only one resolution
  });

  it("does not call getter before any property is accessed", () => {
    const { getter, callCount } = fakeModule({ x: 0 });
    lazyRequire(getter); // just create the proxy — do not touch it
    expect(callCount()).toBe(0);
  });

  it("supports the `in` operator (has trap)", () => {
    const { getter } = fakeModule({ present: true });
    const proxy = lazyRequire(getter);
    expect("present" in proxy).toBe(true);
    expect("absent" in proxy).toBe(false);
  });

  it("supports Object.keys enumeration (ownKeys trap)", () => {
    const { getter } = fakeModule({ foo: 1, bar: 2 });
    const proxy = lazyRequire(getter);
    // ownKeys returns the underlying keys
    const keys = Reflect.ownKeys(proxy);
    expect(keys).toContain("foo");
    expect(keys).toContain("bar");
  });

  it("returns undefined for properties absent from the target", () => {
    const { getter } = fakeModule({ only: 1 } as any);
    const proxy = lazyRequire<any>(getter);
    expect(proxy.missing).toBeUndefined();
  });

  it("proxies nested function invocation", () => {
    const fn = vi.fn(() => "result");
    const { getter } = fakeModule({ doWork: fn });
    const proxy = lazyRequire(getter);
    const out = proxy.doWork();
    expect(out).toBe("result");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("propagates updates if the underlying object is mutated after first access", () => {
    const obj: { counter: number } = { counter: 0 };
    const proxy = lazyRequire(() => obj);
    expect(proxy.counter).toBe(0);
    obj.counter = 7;
    expect(proxy.counter).toBe(7); // re-reads from cached reference
  });

  // The resolution cache (lazy-require.ts `resolve()`) is shared across ALL
  // four proxy traps — get / has / ownKeys / getOwnPropertyDescriptor each call
  // the same memoized `resolve()`. The existing "exactly once" test only
  // exercises repeated `get` access, so a regression where a non-`get` trap
  // re-resolved (or used a separate cache) would pass every other test. This
  // pins that touching the proxy through four different traps still resolves
  // the underlying module exactly once.
  it("resolves exactly once even across different trap types", () => {
    const { getter, callCount } = fakeModule({ foo: 1 });
    const proxy = lazyRequire<{ foo: number }>(getter);
    expect(callCount()).toBe(0); // untouched

    "foo" in proxy; // has trap
    void proxy.foo; // get trap
    Reflect.ownKeys(proxy); // ownKeys trap
    Object.getOwnPropertyDescriptor(proxy, "foo"); // getOwnPropertyDescriptor trap

    expect(callCount()).toBe(1);
  });

  // The existing enumeration tests use Reflect.ownKeys, which calls ONLY the
  // ownKeys trap. Object.keys() is stricter: it drives ownKeys AND then the
  // getOwnPropertyDescriptor trap once per reported key to filter by the
  // `enumerable` flag — and the result must satisfy the Proxy invariants (a key
  // reported by ownKeys but absent from the empty target may not be described
  // as non-configurable). Since the helper's target is `{}` while ownKeys
  // reflects the real module's keys, a regression that pointed
  // getOwnPropertyDescriptor at the empty target (instead of resolve()) would
  // make Object.keys() silently drop every key or throw a TypeError, yet pass
  // every Reflect.ownKeys-based test above. Pins that callers enumerating a
  // lazily-required module (e.g. `Object.keys(core.events)`) see the real,
  // enumerable own keys — and resolves the module exactly once doing so.
  it("Object.keys() enumerates the module's enumerable own keys (ownKeys + descriptor traps)", () => {
    const { getter, callCount } = fakeModule({ foo: 1, bar: 2 });
    const proxy = lazyRequire<{ foo: number; bar: number }>(getter);
    expect(callCount()).toBe(0); // untouched — still lazy
    expect(Object.keys(proxy).sort()).toEqual(["bar", "foo"]);
    expect(callCount()).toBe(1); // enumeration resolved the module just once
  });

  // Every test above reads STRING keys, but the `get` and `has` traps cast
  // `prop as string` and index the resolved module directly — a runtime no-op
  // for symbols. Symbol-keyed exports (Symbol.iterator, Symbol.toStringTag,
  // library-defined symbols used for branding) must therefore reflect into the
  // underlying module too. A regression that string-coerced the key before
  // indexing (e.g. `mod[String(prop)]`) would silently return undefined for
  // symbol exports and report them absent, yet pass every string-keyed test.
  // Pins symbol passthrough for both traps, including symbol identity.
  it("reflects symbol-keyed access into the resolved module (get + has traps)", () => {
    const tag = Symbol("tag");
    const { getter } = fakeModule<Record<string | symbol, unknown>>({ [tag]: "viaSymbol" });
    const proxy = lazyRequire<Record<string | symbol, unknown>>(getter);
    expect(tag in proxy).toBe(true); // has trap resolves symbol key
    expect(proxy[tag]).toBe("viaSymbol"); // get trap returns symbol-keyed value
    expect(Symbol("tag") in proxy).toBe(false); // same description, distinct identity → absent
  });

  it("getOwnPropertyDescriptor returns the underlying descriptor", () => {
    const { getter } = fakeModule({ key: "value" });
    const proxy = lazyRequire(getter);
    const desc = Object.getOwnPropertyDescriptor(proxy, "key");
    expect(desc).toBeDefined();
    expect(desc?.value).toBe("value");
  });
});
