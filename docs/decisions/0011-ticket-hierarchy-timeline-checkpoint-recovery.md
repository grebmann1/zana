# ADR 0011 — Ticket epics, derived timeline, human checkpoints, and crash recovery

- **Status:** Accepted
- **Date:** 2026-06-17
- **Relates to:** ADR 0008 (ticket-automation pipeline), ADR 0002 (tenant isolation)
- **Code:** `packages/work/src/tickets/{db,migration,service,watcher,sweeper}.ts`,
  `packages/core/src/agents/dispatch.ts`,
  `packages/mcp/src/registrations/tickets.ts`

## Context

A 2026-06-17 architecture review of **Orcanator** (a sibling macOS Claude-Code
orchestrator) compared its "cards" work-tracking against our Zana ticket model
field-by-field. The comparison confirmed Zana is *ahead* on several axes our
peer lacks — a first-class `blockedBy` dependency DAG with cycle detection, a
priority-then-age `claim_next` topological dispatcher, structured idempotent
review verdicts, two-phase review, and `workRef` branch/worktree attestation.

It also surfaced four concepts Orcanator models that Zana did not. This ADR
records the decision to adopt them, and the *shape* we adopted (which
deliberately diverges from Orcanator's where our substrate is different).

The two systems embody different philosophies: Orcanator is a human-supervised,
stage-gated pipeline whose entire UI exists so a human can see which agent is
blocked; Zana is an autonomous loop that should surface to a human only on
escalation. We adopted Orcanator's *concepts*, not its *machinery* — no SDLC
node/edge graph, no second history table.

## Decisions

1. **Epic / parent hierarchy is an additive `parentId` column, not a new
   table.** A ticket may point at one parent via `parentId` (nullable). It
   mirrors the `workRef` precedent: additive `ALTER TABLE` in
   `migrateSchemaIfNeeded`, indexed, JSON-fallback-store compatible. Unlike
   `blockedBy` (a DAG), `parentId` is a strict tree — at most one parent — so
   the cycle guard (`wouldCreateParentCycle`) is a linear upward walk, not a
   graph traversal. Re-parenting that would make a ticket its own ancestor is
   rejected; `parentId: null` detaches to top-level.

2. **Epics auto-complete; they are a roll-up, not an independently-driven
   state.** When the last open child of a parent reaches `done`/`cancelled`,
   `maybeCompleteParentEpic` forces the parent to `done` (same forced-terminal
   rationale as `completeTicket` — the children already attest the work is
   finished, so the transition graph is bypassed). It is idempotent (a parent
   already terminal is skipped) and only fires for parents that actually have
   children — a childless leaf is never treated as an epic. Hooked into both
   `completeTicket` and `updateStatus`. This closes the "ghost epic" gap where
   a parent stays open forever after its children finish.

3. **The stage-history timeline is DERIVED from the audit trail, not stored.**
   Orcanator keeps a dedicated `card_stage_history` table; we instead
   reconstruct the timeline in `getTicketTimeline` from the `status_changed`
   audit entries we *already* record on every transition (each carries
   `{from,to,actor,timestamp}`). The result gives per-stage dwell time
   (`durationMs`), an open final stage, and rollups (`reworkBounces`,
   `totalMs` cycle time). We accept the loss of SQL-queryability of a real
   table in exchange for **zero schema drift** — ADR 0008 already makes the
   audit array the authoritative trail, so a second table would be a
   redundant source of truth to keep in sync. (House rule: don't store what
   the system already records.)

4. **The human checkpoint is a first-class, observable state — but
   label-driven, not a new column.** ADR 0008 parked design-only tickets with
   the `awaiting-decision` label but had no resume primitive and no proactive
   surfacing. `requestHumanCheckpoint` parks the ticket (reusing the
   `awaiting-decision` label the auto-implement rule already skips) **and**
   emits `ticket:needsHuman` so a surface layer (inbox, Slack, UI badge) can
   alert proactively. `resolveHumanCheckpoint` clears the gate and optionally
   releases the ticket: `approve` re-queues to `backlog`, `reject` cancels,
   `release` just clears the gate. Keeping it label-driven means it composes
   with the existing watcher `skipLabels` and the escalation lane instead of
   introducing a parallel gating mechanism.

5. **Crash recovery is a PROMPT path that complements (does not replace) the
   24h sweeper.** The ticket-sweeper (`sweeper.ts`) is the slow backstop: it
   cancels long-stale tickets hourly once 24h dead. The gap was the fast path
   — a worker that crashes leaves its ticket wedged in `in-progress` for a
   day. The watcher now tracks `agentId → ticketId` for **every** ticket-driven
   spawn (previously only verdict-bearing review spawns were tracked in
   `inFlightSpawns`). On `agent:terminated` with `reason="errored"` or
   `"spawn-error"`, it calls `service.recoverStuckTicket`, which forces the
   still-in-flight ticket to `blocked` (the graph forbids `in-progress→blocked`,
   but a crash is the authorized exception) and raises a human checkpoint so it
   is surfaced rather than silently parked.
   - `completed` / `killed` / `daemon-restart` are **not** failures: a completed
     worker already drove its own transition; killed/restart are operator
     actions. They never recover.
   - `recoverStuckTicket` no-ops a ticket that already moved on (`status` no
     longer `in-progress`/`rework`), so a worker that reported progress before
     exiting nonzero is never clobbered. The transient-retry machinery parks
     failures in `"retrying"` (not terminated), so a terminated-errored agent
     genuinely means retries are exhausted.

## What we deliberately did NOT adopt

- **No SDLC node/edge graph or per-ticket pipeline templates.** Orcanator's
  configurable stage graph overlaps heavily with our autopilot step sequences
  and the watcher's `STATUS_TRANSITIONS` + rules. Making the stage graph
  data-driven per-ticket is a large, partly-redundant change; deferred.
- **No `card_stage_history` table.** See decision 3.
- **No artifact↔stage binding.** Considered (Orcanator binds PRD/design/test
  reports to an SDLC stage); deferred — `workRef` + CAS artifacts cover the
  acute "reviewer found the wrong tree" case ADR 0008 already addressed.

## Consequences

- Six new MCP verbs / dispatch cases: `ticket_timeline`, `ticket_children`,
  `ticket_request_human`, `ticket_resolve_human`, plus `parentId` on
  `ticket_create` / `ticket_edit`.
- Three new bus events: `ticket:needsHuman`, `ticket:humanResolved`,
  `ticket:recovered` (in addition to the existing `ticket:*`). Surface layers
  consume `ticket:needsHuman` for proactive alerting.
- A crashed implementer is now recovered in seconds, not 24h. The sweeper
  remains the backstop for the cases the prompt path can't see (lost
  `agent:terminated`, daemon restart mid-flight).
