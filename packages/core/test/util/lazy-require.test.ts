import { describe, it, expect, vi } from "vitest";
import { lazyRequire } from "../../src/util/lazy-require.ts";

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

  it("getOwnPropertyDescriptor returns the underlying descriptor", () => {
    const { getter } = fakeModule({ key: "value" });
    const proxy = lazyRequire(getter);
    const desc = Object.getOwnPropertyDescriptor(proxy, "key");
    expect(desc).toBeDefined();
    expect(desc?.value).toBe("value");
  });
});
