---
name: zana:council:arch
description: Convene an architecture-review council — security-reviewer, performance-engineer, researcher (generalist seat) by default. Native fan-out, in-session, dissent preserved verbatim.
argument-hint: <design question | RFC>
allowed-tools: Agent SendMessage mcp__zana__zana_get_profile
---

# /zana:council:arch

A specialization of `/zana:council` that pre-resolves voters from the **`arch` role pack** — the same ladder used by the daemon path's `voters: { pack: "arch", quantity: N }` shape.

| Quantity | Voters |
|---|---|
| 1 | security-reviewer |
| 2 | + performance-engineer |
| 3 (default) | + researcher *(generalist seat)* |
| 4 | + api-designer |
| 5 | + architect |

The user's question is in `$ARGUMENTS`. Default quantity is 3.

## Argument parsing

`$ARGUMENTS` is the question by default. If `$ARGUMENTS` starts with `--quantity N` (or `-q N`), strip that prefix and treat `N` as the number of voters; the remainder is the question. Clamp `N` to `[1, 5]`.

If `$ARGUMENTS` is empty, ask "What should the architecture council deliberate on?" and stop.

## Workflow

1. **Parse** — extract optional `--quantity N` (default 3); the rest is the question.

2. **Resolve voters** from the arch ladder:
   - `1` → `[security-reviewer]`
   - `2` → `[security-reviewer, performance-engineer]`
   - `3` → `[security-reviewer, performance-engineer, researcher]`
   - `4` → `[security-reviewer, performance-engineer, researcher, api-designer]`
   - `5` → `[security-reviewer, performance-engineer, researcher, api-designer, architect]`

3. **Pre-flight** — for each resolved voter, call `mcp__zana__zana_get_profile` with `{ "profileId": "<id>" }` to fetch `systemPrompt` and `displayName`. Batch all calls in a single tool-use block.

4. **Announce intent** in one line, e.g. `Convening arch council (3): security-reviewer + performance-engineer + researcher → synthesizer.`

5. **Build the spawn plan** — one synthesizer + N voters, all spawned in ONE tool-use block:

   - **Voter agents** (`run_in_background: true`):
     - `name`: profile id.
     - `subagent_type`: `general-purpose` (or `Plan` for `architect`).
     - `prompt`: concatenate
       1. `You are the {{displayName}} on an architecture-review council deliberating: "{{question}}". Your name in this session is "{{voterName}}".`
       2. The voter's profile `systemPrompt`.
       3. The question verbatim, prefixed `Question:`.
       4. Stance instructions:
          - `Emit a single stance: APPROVE or CHANGES.`
          - `Provide a rationale of 3–8 sentences specific to your architectural specialty (security posture, performance/scalability, API ergonomics, generalist cross-cutting concerns, or design coherence depending on your role).`
          - `If you have dissenting concerns, state them explicitly — they will NOT be collapsed by synthesis.`
       5. Handoff: `When you finish, call SendMessage({ to: "synthesizer", summary: "<APPROVE|CHANGES> stance from <voterName>", message: "<your full rationale>" }) and stop.`

   - **Synthesizer agent** (`run_in_background: true`):
     - `name`: `synthesizer`.
     - `subagent_type`: `general-purpose`.
     - `prompt`:
       1. `You are the synthesizer for an architecture-review council deliberation on: "{{question}}".`
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
       5. `Return a single message with the synthesis report + verdict + verbatim per-voter rationales. Do not SendMessage; the host conversation reads your final return value directly.`

6. **Spawn — one tool-use block.** Issue all N voter `Agent` calls + the synthesizer `Agent` call together. No kickoff `SendMessage` is needed.

7. **Render the launch summary**:
   ```
   Architecture council convened (native, in-session).
     Question: <trimmed>
     Voters:   <comma-separated voter ids>
     Synthesizer: synthesizer (waiting for <N> stances)
   ```

8. **Stop.** Do not poll. The synthesizer returns the verdict when all stances are in.

## When to prefer the daemon path

Use `mcp__zana__zana_deliberate` with `voters: { pack: "arch", quantity: N }` when you need:

- Multi-round convergence with replayable audit.
- Content-addressed rationales (`rationaleHash`, `synthesisHash`).
- Auto-judge or human-override flow on escalation.

The native path is right for "I want a fast architectural sanity check from three specialists." The daemon path is right for "this design decision needs governance."

## Rules

- ALWAYS spawn all voters AND the synthesizer in ONE tool-use block.
- ALWAYS use `run_in_background: true`.
- The synthesizer MUST preserve dissent verbatim.
- The researcher seat at quantity≥3 is the **generalist seat** — voters above index 2 are specialist additions; do not drop the researcher to fit a smaller council.
- Do NOT call `mcp__zana__zana_deliberate` from this command — that's the daemon path.
- Do NOT pick a verdict at the host level — only the synthesizer emits the verdict.

## Now convene the architecture council on:

$ARGUMENTS
