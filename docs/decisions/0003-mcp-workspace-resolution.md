# ADR 0003 — MCP server workspace resolution (`ZANA_WORKSPACE` → cwd)

- **Status:** Accepted
- **Date:** 2026-06-12

## Context

The Zana MCP server boots the in-process core against a single workspace root
and passes it to the workspace-context singleton (see ADR 0002). The whole
tenant-isolation guarantee depends on that root being the project the user is
actually working in.

The original fallback, when `ZANA_WORKSPACE` was unset, resolved the workspace
from `__dirname` — the MCP **package's install location**:

```js
const workspace = process.env.ZANA_WORKSPACE
  || require("path").resolve(__dirname, "..", "..", "..", "..");
```

This is wrong in two ways. For a global `npx -y @zana-ai/mcp` install,
`__dirname` resolves into the npm cache (`~/.npm/_npx/...`) — a directory that
can be evicted, and that is identical across every project. For a local dev
build it resolves to the Zana repo itself. Either way, with the env var unset,
**every project funnels its tickets/runs into one shared store**. Verified
empirically: with `ZANA_WORKSPACE` unset, a ticket created from project X landed
in the install dir, not X.

## Decision

When `ZANA_WORKSPACE` is unset, fall back to `process.cwd()` — the launching
process's working directory, which Claude Code sets to the active project — not
`__dirname`. `packages/mcp/src/mcp-server.ts`:

```js
const workspace = process.env.ZANA_WORKSPACE || process.cwd();
```

Resolution order is therefore: explicit `ZANA_WORKSPACE` (recommended;
registrations SHOULD pin it per project) → launch cwd (the safety net). We
deliberately do **not** fall back to `__dirname`: cwd is the project, the
package install dir is not.

A shared, user-scoped MCP registration (`claude mcp add -s user …`) serves many
projects from one server, so it MUST pin `ZANA_WORKSPACE` per project; a
per-project `-s local` registration gets the correct cwd automatically. The
server logs its chosen workspace at startup
(`[zana-mcp] booting core in-process for: <path>`).

## Consequences

- With the env var unset, tickets/runs land in the project the user is in, not
  a shared bucket — closing the cross-project mixing hole that ADR 0002's
  guarantee assumed was already closed upstream.
- Documented in `packages/mcp/README.md` and `INSTALL.md`; the per-project pin
  pattern is `--env ZANA_WORKSPACE="$PWD"`.
- The published npm package must ship this fix for global `npx` users to get it
  — i.e. it requires a release (0.2.0), not just a local rebuild.
- An inline comment at the call site explains why `__dirname` is wrong, so the
  fallback isn't "fixed" back during a future cleanup.
