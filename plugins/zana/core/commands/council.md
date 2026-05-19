---
name: zana:council
description: Run a multi-voice deliberation — parallel review by specialist profiles, synthesis, up-to-N convergence rounds, settle or escalate to human. Each voter is an independent Claude with its own profile/lens. Dissent is preserved verbatim.
argument-hint: <task | question>
allowed-tools: Bash Read mcp__zana__zana_deliberate mcp__zana__zana_deliberation_status mcp__zana__zana_deliberation_list mcp__zana__zana_deliberation_override
---

# /zana:council

You are running a deliberation. A council of independent specialist agents
will review the question in parallel, synthesize their reviews, and converge
through up to N rounds. Dissent is preserved verbatim — never collapsed.

The user's question (or task) is in `$ARGUMENTS`.

## Defaults (friendly)

When the user only supplies a question, run with:

- **voters**: `["architect", "security-reviewer", "researcher"]` (3 voters → majority quorum = 2)
- **rounds**: `2`
- **mode**: `"synthesis"`
- **riskTag**: `"medium"`
- **quorum**: `"majority"` (the tool default)

If `$ARGUMENTS` is empty, ask the user "What should the council deliberate on?" and stop. Do not invoke the tool with an empty question.

## Workflow

1. **Trim** the user's question. Treat all of `$ARGUMENTS` as the prompt.

2. **Tell the user what you're about to do** in one short line, e.g.
   `Convening council: architect + security-reviewer + researcher (2 rounds, medium risk).`

3. **Call the tool** — `mcp__zana__zana_deliberate` with:
   ```
   {
     "question": "<trimmed $ARGUMENTS>",
     "voters": ["architect", "security-reviewer", "researcher"],
     "rounds": 2,
     "mode": "synthesis",
     "riskTag": "medium"
   }
   ```
   The call blocks until the deliberation is SETTLED or ESCALATED. Do not poll — the handler runs the full state machine internally.

4. **Render the verdict inline**, in the format below. If the result includes a `synthesisHash`, you may load the synthesis report bytes via `Read` on `~/.zana/artifacts/blobs/<aa>/<rest>.bin` (where `<aa>` is the first two chars of the hash and `<rest>` is the remaining chars + `.bin`). If the bytes aren't available, summarize from the `dissent` and `votes` arrays the tool returned.

5. **Audit pointer** — always end with the absolute path to the deliberation checkpoint, e.g. `~/.zana/checkpoints/<deliberationId>.json`, so the user can replay the run.

## Output format

Render as a single block, using the example below as a template. The phase
trace is optional but helpful — derive it from the deliberation record's
`currentRound`, `voters`, and `dissent` arrays.

```
> /zana:council should we drop Node 18 in v3?

Phase 1: REVIEWING (3 voters)        ✓
Phase 2: SYNTHESIZING                 ✓
Phase 3: CONVERGING (round 1)         ✓ — 2 APPROVE, 1 CHANGES
Phase 4: CONVERGING (round 2)         ✓ — 3 APPROVE
Phase 5: SETTLED → pending_human (dissent recorded in round 1)

VERDICT: APPROVE WITH CONDITIONS  (final tally 3A / 0C, dissent preserved)

Synthesis:
- [CRITICAL] CVE backport burden underestimated — flagged by security-reviewer
- [MAJOR]    Drop Node 18 in v3.0; ship v2.x LTS branch through 2026-09 — consensus
- [MINOR]    Update CI matrix to test against 20.x and 22.x — consensus

Dissent (security-reviewer, round 1):
> "CVE backport burden was minimized in the round-1 synthesis. v2.x LTS without active maintenance creates a vendor-trust risk we should explicitly call out."

Audit: ~/.zana/checkpoints/<deliberationId>.json
```

### Required fields in the rendered output

- **Final tally** — count of `APPROVE` vs `CHANGES` votes from the final round
- **Verdict** — one of `APPROVE` / `APPROVE WITH CONDITIONS` / `REJECT` / `ESCALATED`
  - Map from the deliberation record: `verdict === "approve"` → `APPROVE`; `dissent.length > 0 && verdict === "approve"` → `APPROVE WITH CONDITIONS`; `verdict === "reject"` → `REJECT`; `_outcome` starts with `"escalated"` → `ESCALATED`
- **Synthesis** — bullet list from the synthesis report
- **Dissent** — verbatim quote of every dissent record (never collapse, never paraphrase)
- **Per-voter votes** — profile id, bit (`APPROVE` / `CHANGES`), and the rationale hash so the user can content-address it
- **Audit pointer** — absolute path to the checkpoint file

## Escalation handling

If the tool returns with `_outcome` of `escalated`, `escalated_at_assembly`, or `escalated_during_reassembly`:

1. Render `VERDICT: ESCALATED` and the reason from `_assemblyEscalation` / `_reassemblyEscalation` / `escalationReason`.
2. Tell the user how to act:
   - Review the run: `/zana:council:status <deliberationId>`
   - Override the verdict: `/zana:council:override <deliberationId> <approve|reject|rework> "<reason>"`
3. Stop. Do not auto-recover.

## Subcommands

The council family also exposes:

- `/zana:council:status <deliberationId>` — load a deliberation by id and render its full record
- `/zana:council:list [state]` — list all deliberations, optionally filtered by state
- `/zana:council:override <deliberationId> <approve|reject|rework> <reason>` — record a human override

These are separate slash commands (own files in this directory). This file (`/zana:council`) only handles the primary "convene the council" flow.

## Rules

- Do NOT silently collapse dissent. Quote it verbatim.
- Do NOT pick a side at the round cap. Surface the escalation and stop.
- Do NOT mutate any ticket / artifact based on the verdict — the verdict is a *proposal*, not an action.
- Use the friendly defaults unless the user explicitly overrides voters / rounds / risk in their prompt.

## Now run the council on:

$ARGUMENTS
