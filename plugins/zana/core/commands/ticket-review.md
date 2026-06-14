---
name: zana:ticket:review
description: Native two-phase ticket review gate — spawns a code-reviewer (QA) then an architect (architecture) in-session, parses each VERDICT, and advances/reworks/completes the ticket. Mirrors the daemon watcher, no daemon required.
argument-hint: <ticketId>
allowed-tools: Agent mcp__zana__zana_get_profile mcp__zana__zana_ticket_get mcp__zana__zana_ticket_update_status mcp__zana__zana_ticket_update mcp__zana__zana_ticket_comment mcp__zana__zana_ticket_complete
---

# /zana:ticket:review

Run the **native** ticket review gate inside this Claude Code session. The daemon's ticket
watcher (`packages/work/src/tickets/watcher.ts`) auto-spawns reviewers when a ticket enters
`review`; with no daemon attached, nothing does. This command is that gate: it walks a ticket
through the same two phases the watcher enforces — `code-reviewer` for QA, then `architect`
for architecture — using `Agent` to spawn each reviewer in-session and capturing its final
message as the verdict (the same final-message contract `/zana:council` relies on).

The ticket id is in `$ARGUMENTS`. If empty, ask the user for a ticket id and stop.

## State graph (identical to the daemon)

```
in-progress → review(qa) → review(architecture) → done
                  ↓ FAIL          ↓ FAIL
                rework ←───────────┘
                  ↓ (after 3 cycles)
                blocked (human required)
```

## Workflow

1. **Load** the ticket: `mcp__zana__zana_ticket_get` with `{ "ticketId": "<id>" }`. If it returns
   an error or no ticket, surface it and stop.

2. **Precondition check** on `ticket.status`:
   - `backlog` → tell the user to claim and work it first (`/zana:ticket:complete` claims, or a
     worker agent does); a ticket with no implementation has nothing to review. Stop.
   - `done` / `cancelled` → say it's already closed; stop (suggest reopening if they meant to).
   - `blocked` → say it's blocked pending human triage; read the audit comments and stop.
   - `in-progress`, `review`, or `rework` → proceed.

3. **Enter review**:
   - If status is `in-progress`: call
     `mcp__zana__zana_ticket_update_status` with `{ "ticketId": "<id>", "status": "review" }`. The
     service auto-sets `reviewPhase: "qa"`.
   - If status is `rework`: call `zana_ticket_update_status` to `in-progress`, then to `review`
     (the transition map forbids `rework → review` directly). This re-enters at `qa`.
   - If status is already `review`: resume at the ticket's current `reviewPhase` (`qa` or
     `architecture`) — do not reset it.

4. **Announce** in one line, e.g. `Reviewing ticket <shortId> — QA phase (code-reviewer).`

5. **QA phase** (when `reviewPhase` is `qa`):
   - **Fetch persona**: `mcp__zana__zana_get_profile` with `{ "profileId": "code-reviewer" }` to
     get its `systemPrompt` and `displayName`.
   - **Spawn one reviewer** — a single `Agent` call, `run_in_background: true`,
     `subagent_type: general-purpose`, `name: code-reviewer`. The prompt concatenates:
     1. Role banner: `You are the {{displayName}} reviewing a Zana ticket. Your name in this session is "code-reviewer".`
     2. The profile `systemPrompt`.
     3. The QA review template **verbatim** (matches `watcher.ts` QA rule):
        ```
        QA Review for ticket "<title>" (ID: <id>).

        Description: <description>

        Read the relevant files. Evaluate correctness, security, and code quality.

        REPLY FORMAT — your output MUST end with EXACTLY ONE of these lines (no markdown around it):
        VERDICT: PASS
        VERDICT: FAIL — <one-line reason>

        PASS = code is good enough to advance to architecture review.
        FAIL = issues remain; ticket should go to rework with your findings as the reason.

        Be terse. Lead with the verdict reasoning, end with the VERDICT line.
        ```
   - **Wait** for the task-notification (do NOT poll). Its `result` is the reviewer's final
     message. Parse the **last** line matching `VERDICT:\s*(PASS|FAIL)` (case-insensitive); capture
     any `— <reason>` tail.
   - **Record** the full review verbatim as a comment: `mcp__zana__zana_ticket_comment` with the
     reviewer's message (truncate to ~4000 chars if huge).
   - **On PASS** → `mcp__zana__zana_ticket_update` with
     `{ "ticketId": "<id>", "reviewPhase": "architecture" }`. Continue to step 6.
   - **On FAIL** → go to step 7 (rework) with the reviewer's reason.
   - **No parseable VERDICT** → treat as inconclusive: comment that the reviewer didn't emit a
     verdict, leave the ticket in `review`/`qa`, and stop so the user can decide.

6. **Architecture phase** (`reviewPhase` is `architecture`):
   - **Fetch persona**: `zana_get_profile` for `architect`.
   - **Spawn one reviewer** — single `Agent` call, `run_in_background: true`,
     `subagent_type: general-purpose` (or `Plan`), `name: architect`. Prompt concatenates the role
     banner, the `architect` `systemPrompt`, and the architecture template **verbatim** (matches
     `watcher.ts` architecture rule):
     ```
     Architecture Review for ticket "<title>" (ID: <id>).

     Description: <description>

     Check that the implementation matches the architecture, design docs, and conventions. Read shared artifacts for context.

     REPLY FORMAT — your output MUST end with EXACTLY ONE of these lines:
     VERDICT: PASS
     VERDICT: FAIL — <one-line reason>

     PASS = ticket is done.
     FAIL = architectural issues; ticket should go to rework.

     Be terse.
     ```
   - **Wait**, parse the last `VERDICT:` line, **comment** the review verbatim (as in step 5).
   - **On PASS** → `mcp__zana__zana_ticket_complete` with
     `{ "ticketId": "<id>", "resultSummary": "Approved by native review (QA + architecture)." }`.
     Continue to step 8.
   - **On FAIL** → go to step 7 (rework).
   - **No parseable VERDICT** → inconclusive (as in step 5); stop.

7. **Rework** (a phase returned FAIL):
   - Call `mcp__zana__zana_ticket_update_status` with `{ "ticketId": "<id>", "status": "rework" }`.
     The service increments `reworkCount`.
   - **Re-fetch** the ticket (`zana_ticket_get`) to read the new `reworkCount`.
   - **Rework cap** — if `reworkCount >= 3` (the daemon's `MAX_REWORK_CYCLES`):
     - `zana_ticket_comment` with body `BLOCKED: failed review 3 times — needs human triage.`
     - `zana_ticket_update_status` to `blocked`.
     - Tell the user the ticket is blocked and stop.
   - Otherwise: report "ticket sent to rework (cycle N/3); the reviewer's feedback is in the
     comments — have the worker address it, then re-run /zana:ticket:review." Stop.

8. **Render** a compact result block:
   - `ticketId` (full), final `status`
   - QA verdict (PASS/FAIL + reason), architecture verdict (if reached)
   - `reviewPhase` reached, `reworkCount`
   - For a completed ticket, note it's `done` and reviewed.

## Rules

- **One reviewer at a time.** Phases are sequential — spawn the architect only after QA PASSes,
  exactly like the daemon. Do not parallelize the two phases.
- **The reviewer owns the verdict.** Never decide PASS/FAIL yourself at the host level — parse it
  from the reviewer's final message. If absent, treat as inconclusive; do not guess.
- **Preserve feedback verbatim.** Comment the reviewer's full message; do not paraphrase or
  summarize away the findings — they're the audit trail and the worker's rework brief.
- **Templates are verbatim.** The QA and architecture prompts above match the daemon watcher's
  `promptTemplate`s so native and daemon reviewers behave identically. Do not reword them.
- Reviewers are top-level subagents spawned by this command, so final-message capture works; they
  do NOT call `SendMessage`.
- Only call the tools in `allowed-tools`.

## Relationship to other commands

- `/zana:ticket:complete <id> <summary>` closes a ticket directly. It warns when the ticket never
  went through review and points here — but allows the deliberate skip for trivial work.
- The **daemon path** does this automatically once `ZANA_DAEMON_TOOLS` / `zana headless` is
  running; this command is the in-session equivalent for a plain Claude Code chat.
- For a broader multi-voice design review (not the ticket gate), see `/zana:council` and
  `/zana:council:arch`.

## Now review:

$ARGUMENTS
