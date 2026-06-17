# ADR 0008 — The ticket-automation pipeline (watcher rules, verdicts, escalation)

- **Status:** Accepted
- **Date:** 2026-06-17
- **Relates to:** ADR 0007 (profile model tiering), ADR 0002 (tenant isolation)
- **Code:** `packages/work/src/tickets/watcher.ts`, `.../service.ts`,
  `packages/core/src/core.ts` (auto-router bridge),
  `packages/core/src/agents/spawner.ts` (MCP injection)

## Context

v0.3.0 turned the ticket-watcher from a fan-out *notify* engine (trigger →
spawn → side-effect) into a multi-stage **work pipeline**: a ticket flows
`created → (triage) → assigned → claimed → (implement) → review → (verdict) →
done`, with a design-only escalation lane and a rework cap. Several non-obvious
decisions were made; a 2026-06-17 architect review then found two that were
wrong and corrected them. This ADR records the contract so a future reader
doesn't re-litigate it.

## Decisions

1. **Auto-implement on `ticket:claimed`.** Claiming a ticket with a bound
   `assigneeProfileId` spawns that profile to do the work (closes the front of
   the pipeline; the review rules already covered everything after). It is
   **fire-and-forget** — the implementer drives its own `status → review`
   transition via `zana_ticket_update`, rather than the watcher parsing its
   output. Design-only/parked tickets (`awaiting-decision` label) are skipped
   via the rule's `skipLabels`.

2. **`expectVerdict` is opt-IN (default false).** Only review/rework rules whose
   *terminal output decides a transition* set `expectVerdict: true` and get
   tracked in `inFlightSpawns` for `applyVerdict`. All other spawns (implement,
   triage, design) are fire-and-forget. (Initially shipped default-true for
   back-compat; the review showed that footgunned any user notifier rule into a
   spurious "no VERDICT — manual intervention" comment, so it was flipped.)

3. **Structured verdicts over text parsing.** Reviewers call `zana_ticket_verdict`
   (→ `service.recordVerdict` → `ticket:verdict` bus event). The legacy
   `VERDICT: PASS/FAIL` text line is a **deprecated fallback**, kept one release
   for back-compat and deduped against the structured path so the two never
   double-apply. The shared transition logic (`applyParsedVerdict`) is
   **idempotent**: it re-reads the ticket's current state and no-ops a verdict
   that no longer applies (e.g. a stale PASS arriving after a FAIL already moved
   the ticket to rework) — this defends the unordered race between
   `agent:terminated` and `ticket:verdict`.

4. **Escalation is label-driven, not confidence-driven.** Tickets carrying a
   `system.escalationLabels` label (default `architecture` / `needs-decision` /
   `invariant`) route to the design-only lane: an architect produces a design +
   ADR, the ticket is parked `awaiting-decision` for a human, and auto-implement
   is suppressed. LOW router confidence is explicitly NOT escalation (it usually
   just means "no routing history yet") — those tickets get tagged `needs-triage`
   instead of burning an architect. The auto-router bridge runs on both
   `ticket:created` and label edits (`ticket:updated`), so late-labelled tickets
   still escalate.

5. **The auto-router bridge lives in `core`, not `work`.** `work` deliberately
   does not depend on `intelligence` (it would deepen the require-cycle, ADR
   0001). Core has both the task router and the ticket service in scope, so the
   `ticket:created`/`ticket:updated` → route → assign/escalate bridge is wired
   there.

6. **The spawner injects the zana MCP server by default for headless workers.**
   A worker told to call `zana_ticket_*` must actually have those tools. A
   profile may carry an explicit `mcpConfig`; otherwise — unless it sets
   `noZanaMcp: true` — the spawner injects a default `zana` server (the
   orchestrator-mcp shim, wired to this daemon's hook port). Opt-OUT, not opt-in,
   because forgetting it fails **silently** (the worker can't report back, the
   ticket stalls in-progress forever with no error). The review found every
   built-in worker profile lacked `mcpConfig`, so the autonomous loop did not
   close in the default config; this is the fix.

7. **Concurrency slots release on `agent:terminated`, not a timer.** The watcher
   caps concurrent automations at `MAX_CONCURRENT`. A slot is held for the
   spawned agent's whole lifetime and freed when it terminates (real
   backpressure), with a wall-clock backstop for lost events. (Initially the
   slot freed after a fixed 2000ms — decoupled from the multi-minute agent — so
   the cap was fiction and a creation burst could fan out far past it.)

## Consequences

- "Claim a ticket" and "create a bug ticket" now have side effects (a spawn).
  This is documented in the ticket-lifecycle guide; existing ticket docs that
  predate it are misleading by omission until updated.
- The pipeline is safe to run unattended only with the C1/C6 (MCP injection) and
  C2/C7 (slot release) fixes in place — both landed in the 2026-06-17 follow-up.
- Built-in profiles need no per-profile MCP wiring; a profile opts out with
  `noZanaMcp`.
- `system.escalationLabels` + `system.autoAssignConfidence` are configurable;
  the magic numbers are no longer hardcoded in core.

## Still open / deferred

- Lifting the full review FSM into a single service-owned state machine (the
  review noted the lifecycle state is spread across status/phase/reworkCount +
  several watcher maps). Deferred — the idempotency guard covers the acute risk.
- A `processedStates` visit-epoch for pathological multi-cycle rework re-entry.
