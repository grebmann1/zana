---
name: zana:council:status
description: Load a deliberation by id and render its full state record (votes, dissent, synthesis, verdict).
argument-hint: <deliberationId>
allowed-tools: Read mcp__zana__zana_deliberation_status
---

# /zana:council:status

Load a deliberation by id and render its full record.

The user's argument in `$ARGUMENTS` is the deliberation id (UUID).

## Workflow

1. If `$ARGUMENTS` is empty, ask "Which deliberation? (paste the deliberationId)" and stop.
2. Call `mcp__zana__zana_deliberation_status` with `{ "deliberationId": "<trimmed $ARGUMENTS>" }`.
3. Render:
   - `state` (PROPOSED / REVIEWING / SYNTHESIZING / CONVERGING / SETTLED / ESCALATED / EXHAUSTED)
   - `currentRound` / `rounds`
   - `verdict` + `escalationReason` (if any)
   - Per-voter votes (profileId, bit, rationaleHash)
   - Dissent — verbatim, grouped by round
   - Audit path: `~/.zana/checkpoints/<deliberationId>.json`
4. If the user wants to override an escalated deliberation, point them at `/zana:council:override`.

## Rules

- Do NOT mutate state. This is a read-only view.
- Quote dissent verbatim.
