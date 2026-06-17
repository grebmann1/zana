# ADR 0009 — Freeze multi-daemon swarm, GOAP planner, and vector-memory

- **Status:** Accepted
- **Date:** 2026-06-17
- **Relates to:** ADR 0005 (daemon-tools surface), the 2026-06-17 architect review
- **Code:** `packages/mcp/src/gating.ts`, `registrations/{swarm,intelligence}.ts`

## Context

A 4-architect review (2026-06-17) found the project over-scoped for its age and
staffing: 97 MCP tools and three research-grade subsystems —
multi-daemon swarm, a GOAP planner, and a homegrown vector-memory store — that
have no demonstrated near-term demand, add maintenance/test surface, and blur
the answer to "what is Zana." The concept review recommended cutting them; the
core review noted vector-memory had been in the tenant-isolation bug cluster.

We chose to **freeze, not delete** this round: freezing captures the value
(smaller default surface, clearer story, less to maintain as features) at near-
zero risk and is fully reversible, whereas deletion is irreversible and — for
swarm specifically — requires untangling load-bearing code first (see below).

## Decision

The following tool surfaces are **not registered by default**. Each is dormant
code kept behind an explicit env flag for a future call:

| Subsystem | Tools | Flag to re-enable |
|---|---|---|
| Multi-daemon swarm (sub-daemon spawner) | `zana_swarm_*` | `ZANA_MASTER_MODE=true` **and** `ZANA_SWARM_EXPERIMENTAL=1` |
| GOAP planner | `zana_plan_create` | `ZANA_PLANNER_EXPERIMENTAL=1` |
| Vector-memory | `zana_memory_store`, `zana_memory_search` | `ZANA_MEMORY_EXPERIMENTAL=1` |

Frozen tools are filtered from `tools/list` AND rejected at `tools/call`
(mirrors the daemon-gate, so a client can't bypass the visibility filter).

**Critical scoping correction.** `packages/swarm` is mislabeled: it bundles the
multi-daemon spawner (frozen here) AND the single-daemon **agent P2P inbox**
(`router`/`events` — `drainInbox`/`routeMessage`/`sendAck`, powering
`zana_send_message`/`zana_check_inbox`/inbox compaction, wired unconditionally
into `core.ts`). Only the spawner surface is frozen. The P2P inbox is core
plumbing and is untouched — a flat "delete packages/swarm" would have broken the
single daemon. (Extracting the inbox out of the swarm package is future cleanup.)

We also reposition the product narrative (README/CLAUDE.md): the **daemon is the
product** (persistence, scheduling, autopilot, replayable deliberation — what
`Agent` can't do); **native is a convenience driver** that does not promise
daemon parity. This drops the previously-overstated "works the same on both
paths" claim the review flagged as false.

## Consequences

- Default MCP surface drops by 3 tools (88 surfaced of 91 non-swarm registered;
  the full 97-tool catalog still exists in code and `MCP-TOOL-REFERENCE.md`,
  which documents everything regardless of gating).
- No code deleted; no migration. Re-enabling is a single env flag.
- Three subsystems stop being presented/maintained as shipped features.
- The router/events P2P inbox is explicitly preserved.
- A future hard-delete (if the freeze proves them dead) must first split the
  P2P inbox out of `packages/swarm`; tracked as a follow-up, not done here.
