# ADR 0013 — Headless worker filesystem sandbox (deferred)

- **Status:** Proposed (deferred — not blocking 0.3.0)
- **Date:** 2026-06-23
- **Relates to:** ADR 0002 (tenant isolation), ADR 0006 (MCP→daemon forwarding),
  the spawn cwd/projectId confinement work (`packages/core/src/agents/spawn-cwd.ts`)
- **Code (today):** `packages/core/src/agents/spawner.ts` (`spawnHeadless`,
  `buildClaudeArgs`), `packages/core/src/agents/spawn-cwd.ts`

## Context

A spawned/headless Zana worker is a `claude` child process launched by
`spawnHeadless`. Two separate concerns govern *where* it can act:

1. **Working directory** — which dir the process starts in. As of the
   cwd-confinement work, `resolveConfinedCwd` confines the spawn `cwd` to the
   workspace (or a registered `projectId`), rejecting `../`, symlink, and
   sibling-prefix escapes via realpath. **This is solved.**

2. **Filesystem reach of the worker's tools** — what paths its `Bash`, `Write`,
   and `Edit` tools can touch once running. **This is NOT solved.** A headless
   worker is launched with `permissionMode: "bypassPermissions"` (set in
   `spawnHeadless` when a profile doesn't specify one) because there is no human
   to answer permission prompts — without it the child hangs. `bypassPermissions`
   skips *all* permission checks, including any filesystem boundary. So a worker
   confined to `cwd = /ws/project` can still run `Bash("echo x > /etc/foo")` or
   `Write("/Users/.../.ssh/authorized_keys")` — the cwd is a starting point, not
   a jail.

A live test during the spawn-confinement work confirmed: writes to absolute
paths outside the workspace from a headless worker's Bash are **not** confined.

## The constraint that makes this non-trivial

`bypassPermissions` is load-bearing. Headless workers run unattended; the moment
a permission prompt appears with no TTY to answer it, the worker stalls until
its inactivity timeout and the ticket wedges. Any sandbox design must preserve
"no interactive prompt ever blocks a headless worker" while still bounding the
filesystem. That rules out simply switching to `--permission-mode default`.

## Options considered

### Option A — OS-level sandbox (sandbox-exec / Landlock / container)

Wrap the `claude` child in an OS sandbox that denies writes outside an allowed
path set: `sandbox-exec` (macOS), Landlock/seccomp or bubblewrap (Linux), or a
container mount namespace.

- **Pros:** strongest guarantee — enforced by the kernel regardless of what the
  agent or its tools try; independent of the claude CLI's own permission model.
- **Cons:** per-platform implementation (macOS `sandbox-exec` is deprecated;
  Linux needs Landlock ≥5.13 or bwrap installed); the worker spawns its own
  subprocesses (MCP servers, tool shells) that must inherit the policy;
  hard-to-debug failures that look like flaky tool calls; Windows has no clean
  equivalent. Heaviest to build and maintain.

### Option B — claude `--add-dir` directory boundary

Launch with an explicit allowed-directory set (`--add-dir <root>`) and a
permission mode that honors it, instead of blanket `bypassPermissions`.

- **Pros:** native to the claude CLI; no per-OS code; the boundary travels with
  the tool layer (Bash/Write/Edit respect the allowed dirs).
- **Cons:** must verify CLI 2.1.x actually *enforces* `--add-dir` as a hard
  boundary under a non-interactive mode AND that staying inside the allowlist
  never raises a blocking prompt (the `bypassPermissions` constraint above). If
  enforcement only applies under `default` mode, we'd reintroduce the hang risk.
  Needs a focused capability probe against the pinned CLI before committing.

### Option C — `PreToolUse` hook on Bash/Write/Edit

Register a daemon-side `PreToolUse` hook that inspects each Bash/Write/Edit call,
resolves its target path(s) with the same `resolveConfinedCwd` realpath logic,
and denies (non-interactively) anything outside the confinement root.

- **Pros:** reuses the exact confinement helper we already built and tested;
  single cross-platform implementation in our own code; deny is programmatic, so
  it never raises an interactive prompt — compatible with `bypassPermissions`;
  auditable (every denied path can be logged/emit an event).
- **Cons:** must robustly parse paths out of arbitrary `Bash` command strings
  (the hard part — `cd /x && >y`, `$(...)`, env-var paths, heredocs); a parser
  gap is a silent bypass. Strongest as defense-in-depth layered over A or B, not
  necessarily as the sole control.

## Decision

**Deferred.** The cwd-confinement work (this sprint) closes the spawn-directory
escape, which was the concrete reported gap. Full filesystem sandboxing of a
headless worker's tools is a larger, security-sensitive change that interacts
with every existing headless agent and the load-bearing `bypassPermissions`
mode. It will be designed and reviewed as its own PR after 0.3.0 ships.

Leading direction (to validate, not yet committed): **Option C as the portable
baseline** (reuses our tested realpath confinement, never blocks a headless
worker), with **Option B layered in** if a capability probe confirms CLI
`--add-dir` enforces a hard non-interactive boundary. Option A reserved for
deployments that need a kernel-enforced guarantee.

## Consequences

- Until this lands, a spawned worker is trusted with host-wide filesystem write
  via its tools. Acceptable for the current single-tenant, user-owned-host
  deployment; **must** be closed before any multi-tenant or untrusted-prompt
  use. Tracked here so it isn't silently assumed solved by the cwd confinement.
- The next PR must ship with a capability probe of the pinned claude CLI's
  `--add-dir` / permission-mode behavior, and a Bash-path-parser test corpus if
  Option C is chosen.
