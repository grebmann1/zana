# ADR 0010 — Extract the dependency-free base layer into @zana-ai/contracts

- **Status:** Accepted
- **Date:** 2026-06-17
- **Relates to:** ADR 0001 (the require-cycle and lazyRequire), which this
  partially retires
- **Code:** `packages/contracts/`, `packages/core/src/index.ts` (re-exports)

## Context

ADR 0001 documented a `core ↔ work ↔ extras` require-cycle, worked around with
`lazyRequire` and a dist-subpath import (`@zana-ai/core/dist/src/util/lazy-require`).
A 2026-06-17 architecture review found the reality was worse than "a triad":
`core` was a *god-facade* that `require`d work/extras/intelligence/server/swarm
AND was required by all of them — 147 untyped raw `require("@zana-ai/*")` edges,
3 interlocking cycles.

The **eager** half of that tangle — the part loaded at module-init time, which
is what actually forces the lazy workarounds — is a small set of genuinely
dependency-free leaf modules that everyone consumes:

- `project/workspace-context` (the dominant one — 17 importers)
- `config` (global host paths + constants)
- `events/bus` (the EventEmitter singleton + EVENTS)
- `util/lazy-require` (the Proxy helper itself)
- `util/logger`

None of them import anything from core; they're pure `node:` + constants.

## Decision

Move those five modules into a new **dependency-free leaf package
`@zana-ai/contracts`**. `core` becomes a normal consumer and **re-exports** each
under its historical facade path (`core.project.workspaceContext`, `core.config`,
`core.events.bus`/`EVENTS`, `core.util.{logger,lazyRequire}`,
`core.WorkspaceNotInitializedError`). Every existing
`require("@zana-ai/core").x` / `_core().x` call site is therefore unchanged —
the extraction is back-compatible by construction, not a big-bang rewrite.

Consumers that previously used the dist-subpath workaround for the moved modules
import `@zana-ai/contracts` directly; the workaround is retired for them.

`@zana-ai/contracts` builds FIRST in `build:runtime` (it's the base layer).

### Invariants that had to hold
- **Singleton identity.** `core.events.bus === contracts.bus` and the
  `WorkspaceNotInitializedError` class identity must be shared, or event
  delivery and the tenant-isolation gate would silently break across a
  duplicated module. Verified at runtime.
- **Import style.** Production code imports the moved modules from the
  `@zana-ai/contracts` package index (same singleton instance under Vite SSR
  inlining); tests import from the index too, never a mix of index + dist
  subpath (that produced two transformed instances and a dual-init bug during
  the migration).

## Consequences

- The eager cycle is gone for these five modules; ADR 0001's dist-subpath
  workaround is retired for them. The remaining cycle is the *lazy* runtime
  services (`agents.manager`, `persistence`, `modules.*`, …), still accessed via
  `require("@zana-ai/core")` — out of scope here.
- `core` is no longer the base layer for these primitives; `@zana-ai/contracts`
  is. A future pass can migrate more leaves (e.g. `events/service`) the same way.
- ~200 test files were repointed; tests of the moved modules now live in
  `packages/contracts/test`.
- New packages depending on contracts: core, work, extras, intelligence, server,
  mcp (added as a normal dependency, not peer).

## Not done / deferred
- Migrating the lazy runtime-service half of the cycle (the bigger,
  logic-bearing modules) — a separate future effort.
- Removing the remaining `_core()`/`_work()` ad-hoc helpers — opportunistic, per
  ADR 0001 policy.
