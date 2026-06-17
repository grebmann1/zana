# ADR 0006 — Single agent-registry authority: MCP server forwards lifecycle to the daemon when one exists

- **Status:** Proposed (design accepted; implementation not yet landed — tracks
  ticket `9cd85e67`, labelled `needs-decision`/`design-ready`)
- **Date:** 2026-06-17
- **Relates to:** ADR 0005 (daemon path first-class), ADR 0002/0003 (tenant
  isolation / workspace resolution)

> Promoted from a design artifact (`.zana/artifacts/registry-design-9cd85e67.md`,
> which is gitignored workspace state) so the rationale lives in the durable
> decision record rather than throwaway state. One open item remains before
> coding: confirm the daemon auth-token source file for the HTTP client.

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
