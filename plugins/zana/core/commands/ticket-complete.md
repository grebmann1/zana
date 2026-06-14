---
name: zana:ticket:complete
description: Claim (if needed) and close a Zana ticket with a result summary. Lands the ticket in the done state.
argument-hint: <ticketId> <resultSummary...>
allowed-tools: mcp__zana__zana_ticket_get mcp__zana__zana_ticket_claim mcp__zana__zana_ticket_complete
---

# /zana:ticket:complete

Close a ticket with a written result summary. Claims first if the ticket isn't already claimed by the caller, then completes.

`$ARGUMENTS` is `<ticketId> <resultSummary...>`.

## Workflow

1. **Parse** `$ARGUMENTS` — split on whitespace:
   - `ticketId` (first token)
   - `resultSummary` (everything after the first token, trimmed; required, non-empty)
2. **Validate**:
   - If either is missing, tell the user the expected shape (`<ticketId> <resultSummary...>`) and stop.
   - If `resultSummary` is shorter than ~10 characters, ask them to expand it before recording — empty summaries are an anti-pattern.
3. **Announce** intent in one short line, e.g. `Closing ticket <shortId>: "<summary>".`
4. **Review-gate check** — call `mcp__zana__zana_ticket_get` with `{ "ticketId": "<ticketId>" }` and inspect whether the ticket's review actually **concluded**. The signal is a finished review, NOT merely one that was entered — a ticket sitting in `review` is mid-flight, so closing it would short-circuit an in-progress review and should still warn.
   - **Review concluded** (suppress the warning) if EITHER:
     - it has a review comment recording a reviewer verdict — a comment whose body starts with `VERDICT:`, `**PASS**`, or `**FAIL**`; OR
     - it reached the architecture phase — `reviewPhase` is `"architecture"`, or its `audit` contains a `review_phase_changed` entry with `to: "architecture"` (the QA phase passed to get there).
   - **Review not concluded** (warn) in every other case — including a ticket currently in `review`/`qa` with no recorded verdict yet, or one going straight from `backlog`/`in-progress` to `done`.
   - When review is **not concluded**, print a one-line warning and continue (warn-but-allow — do NOT block):
     `⚠ This ticket hasn't completed review. Run /zana:ticket:review <ticketId> first, or proceed to close it unreviewed (fine for trivial work like doc fixes).`
   - When review **concluded**, say nothing and proceed silently.
   - If `zana_ticket_get` errors (e.g. ticket not found), surface it and stop before claiming.
5. **Claim** — call `mcp__zana__zana_ticket_claim` with `{ "ticketId": "<ticketId>" }`. Returns `{ ok: true, ticket }` on success or `{ error: "..." }` otherwise. The underlying service only allows claiming tickets in `backlog` or `rework` state — claiming a ticket already in `in-progress` / `review` / `done` returns an error like `cannot claim ticket in status: in-progress`. If the response is an error, treat any message containing "cannot claim ticket in status" as "already in flight, proceed to complete anyway"; surface other errors verbatim and stop.
6. **Complete** — call `mcp__zana__zana_ticket_complete` with:
   ```
   {
     "ticketId": "<ticketId>",
     "resultSummary": "<resultSummary>"
   }
   ```
   The tool returns `{ ok: true, ticket }` (or `{ error: "ticket not found" }`). It does NOT require the caller to own the ticket — it sets status to `done` regardless.
7. **Render** the closed ticket from the `ticket` field of the complete response:
   - `ticketId` — `ticket.id` (full id)
   - `status` — should be `done`
   - `resultSummary` — `ticket.resultSummary` (verbatim, quoted)

## Rules

- Claiming is best-effort here — `ticket_complete` does not actually require ownership, so the claim step is for audit-trail completeness only. Do not block the close if the ticket is already in flight.
- The review-gate check is **advisory** — warn, never block. Closing an unreviewed ticket is a deliberate, allowed choice (trivial fixes don't need the two-phase gate). For anything non-trivial, prefer `/zana:ticket:review <ticketId>` before completing.
- Do NOT paraphrase the user's `resultSummary`; pass it through verbatim.
- Do NOT call any tool other than the three listed in `allowed-tools`.

## Monitoring

After closing, the Claude Code status-line footer (if wired to `packages/core/dist/bin/statusline.js`) updates the live `tickets: N doing · N review · N blocked · N todo` counts within `refreshInterval` seconds — no need to re-run `/zana:ticket:list` to confirm the close registered.
