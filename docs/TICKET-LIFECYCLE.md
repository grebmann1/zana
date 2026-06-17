# Ticket lifecycle & automation

How a ticket flows through Zana's automation pipeline, what triggers each step,
and the side effects you should expect. This is the user/contributor map for the
behaviour introduced in v0.3.0. For the *why* behind each decision see
[ADR 0008](decisions/0008-ticket-automation-pipeline.md); the engine is
`packages/work/src/tickets/watcher.ts` + `service.ts`.

> **Heads-up:** creating and claiming tickets now have side effects — they spawn
> agents. This is intentional (that's the automation), but it surprises anyone
> expecting tickets to be inert records.

## The flow

```
                      ┌─────────────────────────────────────────────┐
  create ─────────────▶ backlog                                      │
   │  (ticket:created)  │                                            │
   │                    ├─ bug-labelled? → spawn triage-scout (haiku, read-only)
   │                    │     → comments STILL-OPEN / ALREADY-FIXED / CANNOT-REPRODUCE
   │                    │                                            │
   │                    ├─ escalation label? → escalateForDesign     │
   │                    │     → park "awaiting-decision" + architect design (no code)
   │                    │                                            │
   │                    └─ else → auto-router picks a profile         │
   │                          confident → assigneeProfileId bound     │
   │                          not confident → label "needs-triage"    │
   ▼
 claim (ticket:claimed) ──▶ in-progress
   │                          └─ auto-implement rule → spawn the bound profile
   │                               (skipped if "awaiting-decision")
   │                               worker does the work, then calls
   │                               zana_ticket_update status:review
   ▼
 review / qa ──────────────▶ spawn code-reviewer
   │                          → zana_ticket_verdict PASS|FAIL
   │                            PASS → review/architecture ; FAIL → rework
   ▼
 review / architecture ────▶ spawn architect
   │                          → PASS → done ; FAIL → rework
   ▼
 rework ───────────────────▶ spawn the bound profile again (reads reviewer feedback)
   │                          → READY → back to review/qa ; BLOCKED → blocked
   │                          (after MAX_REWORK_CYCLES=3 failures → auto-blocked)
   ▼
 done
```

## Default rules (`DEFAULT_RULES` in watcher.ts)

| Rule | Trigger | Spawns | Verdict? |
|---|---|---|---|
| `triage-on-create` | `ticket:created` + label `bug` | `triage-scout` | no (comments) |
| `design-only-on-escalation` | `ticket:escalated` | `architect` | no (design comment) |
| `auto-implement` | `ticket:claimed` (skips `awaiting-decision`) | the bound `assigneeProfileId` | no (self-reports via MCP) |
| qa review | status `review`, phase `qa` | `code-reviewer` | yes |
| architecture review | phase → `architecture` | `architect` | yes |
| rework | status `rework` | the bound profile | yes |

"Verdict? = yes" means the rule sets `action.expectVerdict: true`: the watcher
tracks the spawn and applies a PASS/FAIL/READY/BLOCKED transition from its
output. Everything else is **fire-and-forget** — the worker drives its own
transition via the `zana_ticket_*` MCP tools. (`expectVerdict` is opt-in;
default false.)

## Reporting back — structured verdicts

Reviewers should call **`zana_ticket_verdict`** `{ ticketId, verdict, reason }`
(`PASS|FAIL|READY|BLOCKED`). This is deterministic and unaffected by surrounding
text. A legacy `VERDICT: PASS` line at the end of output still works as a
**deprecated fallback** for one release. The two paths are deduped and the
transition is idempotent (a stale verdict for an already-moved ticket is a
no-op), so a worker calling the tool *and* printing the line can't double-apply.

Implementers/triage scouts report via `zana_ticket_update`
(`status: review|blocked`) and `zana_ticket_comment`.

## Labels with meaning

- **`needs-triage`** — the auto-router wasn't confident enough to bind a profile;
  a human should pick one.
- **`awaiting-decision`** — the ticket is parked in the design-only lane; an
  architect has (or will) produce a design + ADR. Auto-implement will NOT fire
  while this label is present. Remove it to release the ticket for
  implementation.
- **escalation labels** (`architecture` / `needs-decision` / `invariant`,
  configurable via `system.escalationLabels`) — route the ticket to the
  design-only lane instead of straight to an implementer.

## Worker tooling (so the loop closes)

A spawned worker can only report back if it has the `zana_ticket_*` MCP tools.
The spawner **injects the zana MCP server by default** for every headless worker;
a profile opts out with `noZanaMcp: true`. Without this the worker would be told
to call `zana_ticket_update` but couldn't, and the ticket would stall in
`in-progress` silently — so the default is opt-out, not opt-in.

## Config knobs (`system` module config)

| Key | Default | Effect |
|---|---|---|
| `autoAssignProfile` | `true` | run the auto-router on ticket creation |
| `autoAssignConfidence` | `0.15` | router score floor to bind a profile (below → `needs-triage`) |
| `escalationLabels` | `["architecture","needs-decision","invariant"]` | labels that route to the design-only lane |
| `autoCloseStale` | `false` | let the triage scout auto-close already-fixed tickets (flag-only when false) |
| `agentTimeoutMinutes` | `10` | idle (not wall-clock) timeout before a worker is reaped |
