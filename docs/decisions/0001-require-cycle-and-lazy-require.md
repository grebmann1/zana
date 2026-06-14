# ADR 0001 — The core↔work↔extras require-cycle and `lazyRequire`

- **Status:** Accepted (the `@zana-ai/contracts` extraction is a future sprint that would retire part of this)
- **Date:** 2026-06-12 (backfilled — the decision predates this ADR)

## Context

`@zana-ai/core`, `@zana-ai/work`, and `@zana-ai/extras` form an intentional
require-cycle:

- `work` needs `core` for the workspace context and event bus,
- `extras` needs `core` for profiles,
- `core` needs `work` for tickets/scheduling and `extras` for skills.

A naive `require()` at module-load time would dereference a half-initialized
sibling and throw (or silently bind `undefined`). Extracting a dependency-free
`@zana-ai/contracts` package would break the cycle properly, but that is a
larger refactor deferred to a future sprint. We need the cycle to not bite in
the meantime.

## Decision

Cross-package references that participate in the cycle go through the typed
`lazyRequire<T>()` helper at `packages/core/src/util/lazy-require.ts`. It fronts
the target module behind a `Proxy` and defers the actual `require()` to first
property access, so module-load ordering no longer matters.

- **New** cross-package lazy references SHOULD use `lazyRequire` (typed, cached,
  one canonical implementation) — not a raw `new Proxy({}, …)`.
- The ~18 existing ad-hoc `function _core() { return require("@zana-ai/core"); }`
  helpers MAY be migrated opportunistically but are not a merge blocker.
- **Consumers outside `@zana-ai/core`** import the helper from the dist subpath,
  `@zana-ai/core/dist/src/util/lazy-require`, NOT the package root. Importing
  from `"@zana-ai/core"` resolves the package main entry and re-triggers the
  cycle at load time, defeating the helper. The dist-subpath import is
  deliberate — do **not** "fix" it back to the package root.

## Consequences

- Module-load order within the cycle is no longer a source of `undefined`
  binding bugs; the first *use* is what resolves the sibling.
- The dist-subpath import reads as a mistake to newcomers — hence this ADR and
  the note in `CLAUDE.md`. It is load-bearing until `@zana-ai/contracts` exists.
- Two patterns (`lazyRequire` and `_core()` helpers) coexist in the same files
  (e.g. `packages/work/src/tickets/db.ts`). Accepted; convergence is gradual.
- Once `@zana-ai/contracts` is extracted and `core` no longer pulls in
  `work`/`extras` at load time, the subpath workaround can be retired in favor
  of the package root. That would supersede this ADR.
