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

4. **Build the spawn plan** — one synthesizer + N voters, all spawned in ONE tool-use block:

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
       5. Handoff: `When you finish, call SendMessage({ to: "synthesizer", summary: "<APPROVE|CHANGES> stance from <voterName>", message: "<your full rationale>" }) and stop.`

   - **Synthesizer agent** (`run_in_background: true`):
     - `name`: `synthesizer`.
     - `subagent_type`: `general-purpose`.
     - `prompt`:
       1. `You are the synthesizer for a council deliberation on: "{{question}}".`
       2. `Wait for SendMessage from all {{N}} voters: {{voter names}}. Each will deliver an APPROVE or CHANGES stance with a rationale.`
       3. `Once all stances are in, build a synthesis report:`
          - `[CONSENSUS] — points where all voters agree`
          - `[MAJORITY] — points where most voters agree`
          - `[DISSENT] — points raised by a minority, quoted VERBATIM (never paraphrase, never collapse)`
       4. `Compute the verdict from the stance tally:`
          - `All APPROVE → VERDICT: APPROVE`
          - `Majority APPROVE with dissent → VERDICT: APPROVE WITH CONDITIONS`
          - `Majority CHANGES → VERDICT: REJECT`
          - `Tie or no majority → VERDICT: ESCALATED (human required)`
       5. `Return a single message containing the synthesis report + verdict + verbatim per-voter rationales. Do not SendMessage; the host conversation reads your final return value directly.`

5. **Spawn — one tool-use block.** Issue all N voter `Agent` calls + the synthesizer `Agent` call together. Do NOT issue a kickoff `SendMessage` — voters don't depend on the synthesizer's start, and they don't message each other.

6. **Render the launch summary** — one block:
   ```
   Council convened (native, in-session).
     Question: <trimmed>
     Voters:   architect, security-reviewer, researcher
     Synthesizer: synthesizer (waiting for 3 stances)

   The synthesizer will return a verdict once all voters have weighed in. Native councils don't have a daemon-side audit checkpoint — for replayable, content-addressed deliberation use mcp__zana__zana_deliberate directly.
   ```

7. **Stop.** Do not poll. The synthesizer's return message lands in the host conversation when complete.

## When to prefer the daemon path

Use `mcp__zana__zana_deliberate` (the slash command does NOT call this — invoke the MCP tool directly) when you need:

- Multi-round convergence (default 2 rounds in the daemon path).
- Content-addressed audit trail (`rationaleHash`, `synthesisHash`, replayable from event log).
- Human-override flow tied to the verdict (`pending_human` routing on dissent / cap hit / `riskTag: "high"`).
- Quorum strictness beyond simple majority (`unanimous`, `<N>`).

The native path is right for "I want three perspectives and a verdict, fast." The daemon path is right for "this decision needs governance."

## Rules

- ALWAYS spawn voters AND the synthesizer in ONE tool-use block. Sequential calls block parallel review.
- ALWAYS use `run_in_background: true` so the host conversation can keep going.
- The synthesizer MUST preserve dissent verbatim. Its prompt enforces this; do not silently weaken it.
- Do NOT call `mcp__zana__zana_deliberate` from this command — that's the daemon path.
- Do NOT pick a verdict at the host level — the synthesizer is the only voice that emits the verdict.

## Now convene the council on:

$ARGUMENTS
