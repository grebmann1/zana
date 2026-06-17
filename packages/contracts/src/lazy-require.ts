/**
 * Typed lazy-require helper.
 *
 * Consolidates the ~16 ad-hoc `new Proxy({}, { get: (_t, p) => require("...")[p] })`
 * hacks scattered across `core / work / extras / intelligence / server`.
 *
 * # Why this exists
 *
 * `core / work / extras` form a require-cycle. The cycle is intentional and
 * accepted (see CLAUDE.md "Repo layout"). To break the cycle at evaluation
 * time without losing type info or call-site ergonomics, we defer
 * `require(...)` to first property-access via a Proxy. This file is the ONE
 * place that pattern lives.
 *
 * # Usage
 *
 * ```ts
 * // INSIDE @zana-ai/core — relative or src import.
 * import { lazyRequire } from "./util/lazy-require";
 *
 * // OUTSIDE @zana-ai/core — import via the dist subpath (see "Dist-path
 * // consumption" below for why the package root would defeat the helper):
 * import { lazyRequire } from "@zana-ai/contracts";
 *
 * // Whole-module:
 * const work = lazyRequire<typeof import("@zana-ai/work")>("@zana-ai/work");
 * work.tickets.service.createTicket(...);
 *
 * // Sub-namespace via getter (avoids touching every call-site when the
 * // surface lives at e.g. `core.events.service`):
 * const eventBus = lazyRequire<EventService>(
 *   () => require("@zana-ai/core").events.service
 * );
 * eventBus.emit(...);
 * ```
 *
 * Both overloads return a Proxy. The underlying module/object is fetched
 * exactly once on first property access and cached for the lifetime of
 * the process. Repeat calls hit the Node `require` cache anyway, but
 * caching here also avoids re-walking nested getter chains.
 *
 * # Dist-path consumption (intentional)
 *
 * Consumers outside `@zana-ai/core` import this helper via
 * `"@zana-ai/contracts"` — NOT from the package root
 * `"@zana-ai/core"`. Going through the package root would resolve the main
 * entry, evaluate the full core module graph at import-time, and re-trigger
 * the very cycle this helper exists to break. The dist-subpath import is
 * therefore intentional; do not "fix" it back to the package root.
 *
 * The workaround can only be retired once `@zana-ai/contracts` is extracted
 * (future sprint) and the cross-package surface area used by lazyRequire
 * callers no longer transitively pulls in `work` / `extras`. Until then,
 * the dist subpath is the contract.
 *
 * # Why not `import`?
 *
 * Static `import` would trigger module evaluation at load time and
 * re-introduce the cycle.
 */
export function lazyRequire<T extends object>(modulePath: string): T;
export function lazyRequire<T extends object>(getter: () => T): T;
export function lazyRequire<T extends object>(target: string | (() => T)): T {
  let cached: T | undefined;
  const resolve = (): T => {
    if (cached === undefined) {
      cached = typeof target === "string" ? (require(target) as T) : target();
    }
    return cached;
  };
  return new Proxy({} as T, {
    get(_, prop) {
      const mod = resolve() as Record<string | symbol, unknown>;
      return mod[prop as string];
    },
    has(_, prop) {
      const mod = resolve() as Record<string | symbol, unknown>;
      return prop in mod;
    },
    ownKeys() {
      return Reflect.ownKeys(resolve() as object);
    },
    getOwnPropertyDescriptor(_, prop) {
      return Reflect.getOwnPropertyDescriptor(resolve() as object, prop);
    },
  }) as T;
}
