# ADR 0002 — Tenant isolation via the workspace-context singleton

- **Status:** Accepted
- **Date:** 2026-06-12 (backfilled — the invariant predates this ADR)

## Context

Zana stores project-local state — `tickets/`, `runs/`, `checkpoints/`,
`scheduler/`, `events/`, `artifacts/` — under each project's `.zana/` directory.
A single host runs Zana across many projects. If any store resolves its path
from the wrong base, one project's state silently mixes into another's. That is
a multi-tenant data-mixing bug, and the most dangerous failure mode is a *silent*
fallback to a shared location where the mixing is invisible until it causes harm.

`~/.zana/` is the **global** fallback for an uninitialized workspace. It is
shared across every workspace on the host, so it must never hold
tenant-isolated state.

## Decision

Every project-local path resolves through the workspace-context singleton at
`packages/core/src/project/workspace-context.ts`. The singleton is initialized
once on app/script start (`core.project.workspaceContext.init(workspaceRoot)`)
and all stores read their paths from `getProjectPaths()`.

Rules:

- Adding a new project-local directory means adding it to **both** branches of
  `getProjectPaths()` — the singleton and the `createForWorkspace(dir)` factory —
  and consuming it via the workspace-context lookup, **not** by joining paths
  from a workspace root in the calling module.
- Tenant-isolated writes (CAS artifacts, `kind: "deliberation"` checkpoints)
  MUST refuse to fall back to `~/.zana/`. Use `WorkspaceNotInitializedError`
  (`workspace-context.ts:24`) to refuse rather than write to the shared global.
- The `init()` on `packages/work/src/runs/checkpoint/store.ts` is for **tests**;
  production code relies on workspace-context resolution.

## Consequences

- Project state cannot silently leak across workspaces through the shared global
  — an uninitialized tenant-isolated write throws loudly instead.
- Every new project-local store carries a two-branch obligation; forgetting one
  branch is the predictable bug, so it's called out here and in `CLAUDE.md`.
- See ADR 0003 for how the MCP server *chooses* the workspace root it passes to
  `init()` — the isolation guarantee is only as good as that choice.
