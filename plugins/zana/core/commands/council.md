---
name: zana:council
description: Convene a multi-voice council in this Claude Code session — N specialist voters spawn in parallel, each emits an APPROVE/CHANGES stance with rationale, a synthesizer collects them and emits a verdict. Dissent is preserved verbatim.
argument-hint: <task | question>
allowed-tools: Agent SendMessage mcp__zana__zana_get_profile
---

# /zana:council

Run a council deliberation **inside this Claude Code session** as a native fan-out: N voter subagents review the question in parallel, each `SendMessage`s its stance + rationale to a synthesizer subagent, the synthesizer aggregates and emits the verdict.

For headless / CI / scheduled deliberations with content-addressed audit and the full state machine (`PROPOSED → REVIEWING → SYNTHESIZING → CONVERGING → SETTLED|ESCALATED|EXHAUSTED`), the daemon path remains available via `mcp__zana__zana_deliberate` (do NOT call it from this command).

The user's question (or task) is in `$ARGUMENTS`.

## Defaults (friendly)

When the user only supplies a question, run with:

- **voters**: `architect`, `security-reviewer`, `researcher` (3 voters → simple majority verdict at the synthesizer)
- **rounds**: 1 (single round of review + synthesis; this is a native simplification of the daemon path's CONVERGING loop — for multi-round convergence with replayable audit trail, use `mcp__zana__zana_deliberate` directly)

If `$ARGUMENTS` is empty, ask the user "What should the council deliberate on?" and stop.

## Workflow

1. **Trim** `$ARGUMENTS`. The full string is the council's question.

2. **Pre-flight** — for each voter profile, call `mcp__zana__zana_get_profile` with `{ "profileId": "<id>" }` to fetch its `systemPrompt` and `displayName`. Batch the three calls in a single tool-use block — they are independent.

3. **Announce intent** in one line, e.g. `Convening native council: architect + security-reviewer + researcher → synthesizer.`

4. **Build the voter spawn plan** — N voter agents, spawned in ONE tool-use block:

   - **Voter agents** (`run_in_background: true`):
     - `name`: profile id (e.g. `architect`, `security-reviewer`, `researcher`).
     - `subagent_type`: `general-purpose` (or `Plan` for `architect`).
     - `prompt`: concatenate
       1. Role banner: `You are the {{displayName}} on a council deliberating: "{{question}}". Your name in this session is "{{voterName}}".`
       2. The voter's profile `systemPrompt`.
       3. The question verbatim, prefixed `Question:`.
       4. Stance instructions:
          - `Emit a single stance: APPROVE or CHANGES.`
          - `Provide a rationale of 3–8 sentences specific to your specialty.`
          - `If you have dissenting concerns, state them explicitly — they will NOT be collapsed by synthesis.`
       5. Output contract: `Your final assistant message IS your stance delivery. Begin it with "Stance: APPROVE" or "Stance: CHANGES" on its own line, followed by your rationale. Do NOT call SendMessage — the host harness captures your final message and routes it to the synthesizer.`

5. **Spawn voters — one tool-use block.** Issue all N voter `Agent` calls together with `run_in_background: true`. Do not spawn the synthesizer yet.

6. **Render the launch summary** — one block:
   ```
   Council convened (native, in-session).
     Question: <trimmed>
     Voters:   architect, security-reviewer, researcher
     Waiting for 3 voter stances before synthesis…
   ```

7. **Wait for all voters to complete.** The harness delivers a task-notification per voter; each notification's `result` field contains the voter's final message (stance + rationale). Do NOT poll. Do NOT spawn the synthesizer until all N voters have reported.

8. **Spawn the synthesizer — one tool-use block, foreground (`run_in_background: false`).**
   - `name`: `synthesizer`.
   - `subagent_type`: `general-purpose`.
   - `prompt`: concatenate
     1. `You are the synthesizer for a council deliberation on: "{{question}}".`
     2. `The {{N}} voters have already reported. Their stances and rationales are pasted verbatim below — do NOT spawn anything, do NOT poll an inbox, synthesize from the text below and return your final report.`
     3. Build a section per voter, in order, formatted as:
        ```
        ==========================================================================
        VOTER <i>: <voterName> — Stance: <APPROVE|CHANGES>
        ==========================================================================
        <verbatim final message from the voter>
        ```
        (Parse the voter's stance from the first `Stance: ...` line of their final message; if absent, infer from the rationale and flag it in the synthesis.)
     4. `Build a synthesis report:`
        - `[CONSENSUS] — points where all voters agree`
        - `[MAJORITY] — points where most voters agree`
        - `[DISSENT] — points raised by a minority, quoted VERBATIM (never paraphrase, never collapse)`
     5. `Compute the verdict from the stance tally:`
        - `All APPROVE → VERDICT: APPROVE`
        - `Majority APPROVE with dissent → VERDICT: APPROVE WITH CONDITIONS`
        - `Majority CHANGES → VERDICT: REJECT`
        - `Tie or no majority → VERDICT: ESCALATED (human required)`
     6. `Return a single message containing the synthesis report + verdict + verbatim per-voter rationales as your final output.`

9. **Stop.** The synthesizer's return value is the verdict. Native councils don't have a daemon-side audit checkpoint — for replayable, content-addressed deliberation use `mcp__zana__zana_deliberate` directly.

## When to prefer the daemon path

Use `mcp__zana__zana_deliberate` (the slash command does NOT call this — invoke the MCP tool directly) when you need:

- Multi-round convergence (default 2 rounds in the daemon path).
- Content-addressed audit trail (`rationaleHash`, `synthesisHash`, replayable from event log).
- Human-override flow tied to the verdict (`pending_human` routing on dissent / cap hit / `riskTag: "high"`).
- Quorum strictness beyond simple majority (`unanimous`, `<N>`).

The native path is right for "I want three perspectives and a verdict, fast." The daemon path is right for "this decision needs governance."

## Rules

- ALWAYS spawn voters in ONE tool-use block with `run_in_background: true` — parallel review is the point.
- ALWAYS wait for all voter notifications before spawning the synthesizer.
- The synthesizer runs AFTER voters complete, with their rationales injected into its prompt — voters do NOT call `SendMessage` (it isn't reliably reachable from nested `general-purpose` subagents in this harness; final-message capture is the contract).
- The synthesizer MUST preserve dissent verbatim. Its prompt enforces this; do not silently weaken it.
- Do NOT call `mcp__zana__zana_deliberate` from this command — that's the daemon path.
- Do NOT pick a verdict at the host level — the synthesizer is the only voice that emits the verdict.

## Now convene the council on:

$ARGUMENTS
