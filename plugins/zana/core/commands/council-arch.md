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

3. **Pre-flight** — for each resolved voter AND the `judge` profile (used by the synthesizer in step 9), call `mcp__zana__zana_get_profile` with `{ "profileId": "<id>" }` to fetch `systemPrompt` and `displayName`. Batch all calls in a single tool-use block.

4. **Announce intent** in one line, e.g. `Convening arch council (3): security-reviewer + performance-engineer + researcher → judge synthesizer.`

5. **Build the voter spawn plan** — N voter agents, spawned in ONE tool-use block:

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
       5. Output contract: `Deliver your stance by calling SendMessage({ to: "main", summary: "<voterName> stance: APPROVE|CHANGES", message: "<your full stance + rationale>" }) as the LAST thing you do. The message body MUST begin with "Stance: APPROVE" or "Stance: CHANGES" on its own line, followed by your rationale. This SendMessage call is the delivery mechanism — do NOT rely on your final assistant message being captured automatically; the convening session reads your stance from the message you send. After sending, you may stop.`

6. **Spawn voters — one tool-use block.** Issue all N voter `Agent` calls together with `run_in_background: true`. Do not spawn the synthesizer yet.

7. **Render the launch summary**:
   ```
   Architecture council convened (native, in-session).
     Question: <trimmed>
     Voters:   <comma-separated voter ids>
     Waiting for <N> voter stances before synthesis…
   ```

8. **Collect all N voter stances from your inbox.** Each voter delivers its stance to you via `SendMessage({ to: "main" })`; the message body is the voter's stance + rationale. Do NOT poll in a busy loop — the messages arrive in your inbox as voters finish. Do NOT spawn the synthesizer until all N voters have reported.
   - **Idle-nudge fallback:** if a voter subagent goes idle (`idle_notification`, `idleReason: "available"`) without having sent its stance message, send it exactly one `SendMessage({ to: "<voterName>", message: "You went idle without delivering your stance. Reply now with SendMessage({ to: \"main\", message: \"Stance: APPROVE|CHANGES\\n<rationale>\" })." })` to nudge it, then resume collecting. This guards the tail case so the council never hangs awaiting a stance that was computed but not delivered.

9. **Spawn the synthesizer — one tool-use block, foreground (`run_in_background: false`).**
   - `name`: `synthesizer`.
   - `subagent_type`: `general-purpose`.
   - `prompt`: concatenate
     1. The `judge` profile's `systemPrompt` (fetched in pre-flight) — purpose-built for adjudication ("pick the position most consistent with the goal, NOT the most popular; weigh dissent seriously"), matching the daemon path which also adjudicates with `judge`.
     2. `You are the synthesizer for an architecture-review council deliberation on: "{{question}}".`
     3. `The {{N}} voters have already reported. Their stances and rationales are pasted verbatim below — do NOT spawn anything, do NOT poll an inbox, synthesize from the text below and return your final report.`
     4. Build a section per voter, in order, formatted as:
        ```
        ==========================================================================
        VOTER <i>: <voterName> — Stance: <APPROVE|CHANGES>
        ==========================================================================
        <verbatim stance message the voter delivered via SendMessage>
        ```
        (Parse the voter's stance from the first `Stance: ...` line of their delivered message; if absent, infer from the rationale and flag it in the synthesis.)
     5. `Build a synthesis report:`
        - `[CONSENSUS] — points where all voters agree`
        - `[MAJORITY] — points where most voters agree`
        - `[DISSENT] — points raised by a minority, quoted VERBATIM (never paraphrase, never collapse)`
     6. `Compute the verdict from the stance tally:`
        - `All APPROVE → VERDICT: APPROVE`
        - `Majority APPROVE with dissent → VERDICT: APPROVE WITH CONDITIONS`
        - `Majority CHANGES → VERDICT: REJECT`
        - `Tie or no majority → VERDICT: ESCALATED (human required)`
        (As the judge, apply these as guidance, not a mechanical tally — a single well-argued CHANGES the others didn't engage can warrant CONDITIONS or ESCALATED even at a numeric majority.)
     7. `Return a single message with the synthesis report + verdict + verbatim per-voter rationales as your final output.`

10. **Stop.** The synthesizer's return value is the verdict.

## When to prefer the daemon path

Use `mcp__zana__zana_deliberate` with `voters: { pack: "arch", quantity: N }` when you need:

- Multi-round convergence with replayable audit.
- Content-addressed rationales (`rationaleHash`, `synthesisHash`).
- Auto-judge or human-override flow on escalation.

The native path is right for "I want a fast architectural sanity check from three specialists." The daemon path is right for "this design decision needs governance."

## Rules

- ALWAYS spawn all voters in ONE tool-use block with `run_in_background: true`.
- ALWAYS collect all N voter stance messages before spawning the synthesizer.
- The synthesizer runs AFTER voters complete, with their rationales injected into its prompt — each voter delivers its stance with `SendMessage({ to: "main" })`. Explicit `SendMessage` delivery is the contract: background `general-purpose` subagents go idle without reliably auto-delivering their final message as a task-notification, so voters MUST push their stance themselves. Do NOT rely on final-message capture.
- The synthesizer carries the `judge` profile's systemPrompt and MUST preserve dissent verbatim.
- The researcher seat at quantity≥3 is the **generalist seat** — voters above index 2 are specialist additions; do not drop the researcher to fit a smaller council.
- Do NOT call `mcp__zana__zana_deliberate` from this command — that's the daemon path.
- Do NOT pick a verdict at the host level — only the synthesizer emits the verdict.

## Now convene the architecture council on:

$ARGUMENTS
