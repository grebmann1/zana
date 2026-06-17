# ADR 0006 — Single agent-registry authority: MCP server forwards lifecycle to the daemon when one exists

- **Status:** Accepted (implemented — closes ticket `9cd85e67`)
- **Date:** 2026-06-17
- **Relates to:** ADR 0005 (daemon path first-class), ADR 0002/0003 (tenant
  isolation / workspace resolution)
- **Code:** `packages/mcp/src/daemon-client.ts` (HTTP client + decision helper),
  `packages/mcp/src/mcp-server.ts` (`callCore` forwarding in `resolveAgentAuthorityPort`)

> Promoted from a design artifact and now implemented. The open item — the
> daemon auth-token source — is resolved: the API server reads/creates a
> host-global token at `~/.zana/auth.json` (`server/src/api/auth-middleware.ts`);
> the MCP server reads the same file to authenticate (`daemon-client.ts
> readAuthToken`). Any host process can read it, which is how a sibling MCP
> server reaches a daemon it didn't start.
>
> Implementation notes vs. the original design:
> - Forwarding is gated by `isForwardable(action)` (the 7 lifecycle actions) and
>   `authorityPortFor(entry, selfPid)` — forward only to a SEPARATE registered
>   daemon that exposes an `apiPort`; never to our own in-process core (which
>   boots `skipApiServer:true`, so it has no apiPort) nor our own pid.
> - Error policy per the ADR: a connection failure / missing token →
>   `DaemonUnreachableError` → fall back to in-process (cache invalidated). A
>   401/403 → `DaemonAuthError` → surfaced, NOT silently fallen back (that would
>   re-fragment the registry with a second authority).
> - `spawn_agent_validated` / `spawn_oneshot` collapse onto `POST /agents` — the
>   daemon owns the live process regardless of the spawn variant.

## Context

Each MCP server process boots core in-process and owns a module-level in-memory
agents Map (`packages/core/src/agents/lifecycle.ts`). An agent record is not
plain data: it owns a live `childProcess`, stream listeners, a timeout, and the
transient-retry state machine — only the spawning process can read its output,
kill it, write to stdin, or retry it. The HTTP daemon owns a SEPARATE Map. When
both run for the same workspace, agents spawned via the MCP server's in-process
`callCore` are invisible to the daemon's `GET /agents` and `zana_list_agents`
from another context, and vice versa — a fragmented registry. Tickets don't have
this problem because they are persisted in a WAL SQLite file (`tickets.db`)
resolved through workspace-context; the agent control surface cannot be
serialized the same way. The fragmentation only manifests on the DAEMON path;
native chats spawn via the built-in `Agent` tool and never touch these tools.

## Decision

When a co-workspace HTTP daemon is registered
(`daemonRegistry.findRunningDaemon(workspace)`), the MCP server FORWARDS
agent-lifecycle commands (spawn/list/status/result/kill/oneshot) to that
daemon's authenticated HTTP API, making it the single authority. When no daemon
is running, the MCP server falls back to its in-process core, which is then the
sole authority — so there is nothing to fragment. Forwarding is scoped to
lifecycle actions only; file/DB-backed domains (tickets, artifacts, schedules,
memory) stay in-process. We deliberately do NOT adopt a shared agent DB: it
could carry metadata but not the live control surface
(childProcess/streams/timers), producing a split-brain where rows and processes
diverge.

## Consequences

- The daemon becomes the authoritative agent registry whenever it exists,
  eliminating fragmentation in the only path where it occurs. Standalone/native
  MCP usage is byte-for-byte unchanged (no daemon → in-process). No
  persisted-format change, no migration.
- New runtime dependency: MCP server gains an authenticated HTTP client and
  daemon-liveness handling, with in-process fallback on connection failure (but
  NOT on auth failure — that surfaces as an error to avoid silent
  re-fragmentation).
- Tenant isolation preserved: forwarding targets only a daemon whose registry
  workspace matches, reusing the post-`6fcb24e6` workspace filter.
- A future read-only metadata index could let non-owning processes DISPLAY (not
  control) remote agents; deferred as observability, not part of this decision.
- If `@zana-ai/contracts` is later extracted and the daemon becomes mandatory,
  this forwarding becomes the only path and the in-process fallback can be
  reconsidered.
