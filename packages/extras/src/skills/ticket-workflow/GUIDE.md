# Working with Zana tickets

You are an agent in a Zana workspace. Work is tracked as **tickets** in a shared
store. This guide is the contract for how you interact with them. Tickets move
through a strict state machine; the `mcp__zana__zana_ticket_*` tools enforce the
legal transitions, so always go through the tools — never assume a status, and
never describe work as done without recording it.

## When this applies

If your prompt names a `ticketId`, you OWN that ticket's lifecycle for the
duration of your task. If it does not, you are working ad hoc — you may still
read or create tickets, but you are not on the hook for a specific one.

## The lifecycle (happy path)

```
backlog → in-progress → review → done
                ↑           │
              rework ←──────┘   (reviewer found real defects)
```

1. **Claim** before you start: `zana_ticket_claim { ticketId, agentName }`.
   This assigns the ticket to you and moves it to `in-progress`. It REFUSES if
   the ticket has unfinished `blockedBy` dependencies — that is correct; do not
   work a blocked ticket. Claim works only from `backlog` or `rework`.
2. **Report progress / plan** with `zana_ticket_update` — set a `progress`
   note, and when you finish the implementation, move it to `review` AND record
   a `workRef`:
   `zana_ticket_update { ticketId, status: "review", progress, workRef: { branch, commitRange, worktree? } }`.
   The `workRef` is not optional etiquette — it tells the reviewer WHICH tree to
   inspect. Without it a reviewer grepping HEAD may not see work committed on a
   branch or worktree, and will wrongly report it missing.
3. **Comment** anything a human or the next agent needs:
   `zana_ticket_comment { ticketId, body }`. Use this for findings, blockers,
   and decisions — it is the durable record (the wiki/log is not read by the
   pipeline).
4. **Complete** only when the work is truly finished and verified:
   `zana_ticket_complete { ticketId, resultSummary, evidence? }`. Pass
   `evidence: { branch, commitRange, testResult, attestedBy }` when you can
   attest "verified-done on branch X, tests pass" — this is the authorized way
   to close a ticket without bouncing it back through review.

NEVER leave a ticket you claimed sitting in `in-progress`. If you cannot finish,
move it to `blocked` and comment why (see Failure). An orphaned `in-progress`
ticket wastes a backlog slot and can only be reconciled by the sweeper hours
later.

## If you are a REVIEWER

Record a structured verdict — do not just narrate. Prefer the tool over ending
your output with a `VERDICT:` line:

`zana_ticket_verdict { ticketId, verdict, reason }` where verdict is one of:

- **PASS** — the work is good. (QA pass advances to architecture review; an
  architecture pass completes the ticket.)
- **FAIL** — the implementation IS present and has real defects. The ticket goes
  to `rework` with your reason. Give a one-line reason.
- **INCONCLUSIVE** — you could NOT locate the implementation on the tree you
  inspected (likely a different branch/worktree). This is NOT a failure: the
  ticket stays in review. Never report FAIL for work you simply could not find —
  that is a false negative. Read the ticket's `workRef` and re-inspect the named
  branch/worktree before judging.
- **READY** / **BLOCKED** — only when finishing a `rework` cycle: READY sends it
  back to review; BLOCKED parks it with a reason.

Inspect the right tree first: read the ticket's `workRef`; if a branch or
worktree is named, inspect THAT (`git log <branch>`, `git diff <commitRange>`),
not just the checked-out HEAD.

## Dependencies, priority, and picking work

- `blockedBy` is a real dependency gate, not a label. A ticket is only claimable
  once every ticket it lists has reached `done`/`cancelled`. To pull the next
  available ticket in correct order, use
  `zana_ticket_claim_next { agentName }` — it returns the highest-priority ready
  ticket (priority then age) and claims it, or `{ ok: false, reason: "none_ready" }`
  when nothing is dispatchable. Call it in a loop to drain a ticket graph.
- `zana_ticket_list_ready` shows what would run next without claiming.
- Express a dependency at create time with
  `zana_ticket_create { title, blockedBy: [<id>...] }`. A cycle is rejected.

## Epics (parent / child tickets)

A ticket can have a `parentId`, making it a child of an **epic**. Create a child
with `zana_ticket_create { title, parentId: <epicId> }` or re-parent later with
`zana_ticket_edit { ticketId, parentId }`. You do NOT complete the epic yourself:
when the LAST open child reaches `done`/`cancelled`, the epic auto-completes. Use
`zana_ticket_children { ticketId }` to see an epic's children. Decompose a large
goal into a parent epic + child tickets rather than one giant ticket.

## When you need a human (checkpoints)

Some decisions are not yours to make autonomously — a risky architectural
choice, an ambiguous requirement, a destructive operation. Raise a checkpoint
instead of guessing or stalling:

`zana_ticket_request_human { ticketId, reason, kind }` (kind: `decision` |
`approval` | `recovery`). This parks the ticket and proactively alerts a human.
Do not poll for the answer — your task ends; a human resolves it later with
`zana_ticket_resolve_human` (approve → re-queues, reject → cancels). Prefer a
checkpoint over silently doing something risky.

## Inspecting history

`zana_ticket_get { ticketId }` returns the full ticket (comments, audit, blockers).
`zana_ticket_timeline { ticketId }` returns the stage history — how long the
ticket dwelled in each status, how many times it bounced through rework, and
total cycle time. Use the timeline to understand a ticket's past before acting.

## Rules of thumb

- Go through the tools; they enforce the legal state machine. A rejected
  transition means you are trying to skip a step — re-read the lifecycle above.
- Record a `workRef` whenever you hand work to review. It is the single biggest
  cause of false "not implemented" reviews when omitted.
- One claimed ticket, one outcome: complete it, block it, or hand it to review.
  Never abandon it in `in-progress`.
- A reviewer that can't find the work reports INCONCLUSIVE, never FAIL.
- Decompose with epics; gate ordering with `blockedBy`; escalate with a human
  checkpoint. Don't reinvent these with labels or comments.
