---
name: zana:council
description: Convene a multi-voice council in this Claude Code session. Voters are auto-selected to fit the request (override with --voters or --pack); each emits an APPROVE/CHANGES stance with rationale, a judge synthesizer collects them and emits a verdict. Dissent is preserved verbatim.
argument-hint: <task | question>
allowed-tools: Agent SendMessage mcp__zana__zana_get_profile mcp__zana__zana_list_profiles
---

# /zana:council

Run a council deliberation **inside this Claude Code session** as a native fan-out: N voter subagents review the question in parallel; the host harness captures each voter's final message (stance + rationale) and feeds them to a synthesizer subagent, which aggregates and emits the verdict. Voters do NOT message each other or the synthesizer — final-message capture is the contract (see Rules).

For headless / CI / scheduled deliberations with content-addressed audit and the full state machine (`PROPOSED → REVIEWING → SYNTHESIZING → CONVERGING → SETTLED|ESCALATED|EXHAUSTED`), the daemon path remains available via `mcp__zana__zana_deliberate` (do NOT call it from this command).

The user's question (or task) is in `$ARGUMENTS`.

## Choosing the roster

The council's voters should fit the **question** — a UI change doesn't need a security reviewer; a crypto change doesn't need a UX designer. There is **no fixed default roster**. Unless the user names voters explicitly, you derive the roster from the request (see "Auto-roster" below).

Precedence (first match wins):

1. **`--voters a,b,c`** — explicit comma-separated profile ids. Convene exactly these (any of the profiles below). Validate each via the pre-flight `zana_get_profile`; if one is unknown, surface the error and stop.
2. **`--pack <id> [--quantity N]`** — a named **role pack** ladder (matches the daemon path's `voters: { pack, quantity }`). Take the first `N` (default 3, clamp `[1,5]`):
   - `arch` → `security-reviewer, performance-engineer, researcher, api-designer, architect` *(or use `/zana:council:arch`)*
   - `code-review` → `code-reviewer, security-reviewer, researcher, performance-engineer, architect`
   - `plan` → `architect, researcher, security-reviewer, api-designer, performance-engineer`
   - `review` → `researcher, code-reviewer, security-reviewer, performance-engineer, architect`
3. **Auto-roster (default, no flags)** — infer the most relevant 3 voters from the question (see below).

In all cases: **rounds = 1** (single round of review + synthesis; a native simplification of the daemon path's CONVERGING loop — for multi-round convergence with a replayable audit trail use `mcp__zana__zana_deliberate` directly).

### Auto-roster — pick voters that fit the request

When the user supplies only a question, choose the roster yourself:

1. **Enumerate the catalog** — call `mcp__zana__zana_list_profiles` once to get the available profiles and their `lens`. The reviewer-relevant lenses are: `architecture`, `security`, `performance`, `api-design`, `code-quality`, `testing`, `ux`, `frontend`, `backend`, `debugging`, `docs`, `research`. (Skip coordination/util profiles — `orchestrator`, `full-auto-coder`, `slack-notifier`, `swarm-*`, and `judge`, which is reserved for the synthesizer.)
2. **Read the question** and pick the **3 lenses whose concerns the question actually raises**, then map each to its profile. Examples (illustrative, not exhaustive):
   - UI / copy / onboarding flow → `ux-designer`, `frontend-dev`, `researcher`
   - API contract / versioning → `api-designer`, `architect`, `security-reviewer`
   - DB query / latency / scale → `performance-engineer`, `backend-dev`, `architect`
   - auth / secrets / crypto / input handling → `security-reviewer`, `code-reviewer`, `architect`
   - test strategy / coverage / flakiness → `test-writer`, `code-reviewer`, `researcher`
   - "why is this failing" / incident → `debugger`, `code-reviewer`, `researcher`
   - broad / cross-cutting / "should we ship" → `researcher`, `architect`, `code-reviewer`
3. **Always include a generalist seat.** Keep `researcher` (or `architect` for design-heavy questions) as one of the three so the council isn't purely specialist. Do **not** reflexively add `security-reviewer` or `performance-engineer` — include them only when the question raises a security or performance concern.
4. **Default size is 3.** Use 2 for a narrow question, up to 5 for a genuinely cross-cutting one. Never fewer than 2 (a council of one is just an agent — tell the user to spawn a single `Agent` instead).
5. **State your reasoning.** In the announce line (step 3) name the chosen voters AND a half-sentence why, so the user can correct you — e.g. `Auto-roster for a UI question: ux-designer + frontend-dev + researcher (no security/perf — not raised by the question).`

If after reading the question the right roster is genuinely ambiguous, ask the user one short clarifying question (or suggest `--voters`) rather than guessing.

If `$ARGUMENTS` is empty (after stripping any flags), ask the user "What should the council deliberate on?" and stop.

## Workflow

1. **Resolve the roster** (see "Choosing the roster"): if `--voters` or `--pack` is present, use it; otherwise **auto-roster** — call `mcp__zana__zana_list_profiles`, read the question, and pick the 2–5 voters whose lenses the question actually raises (default 3, always one generalist). The remainder of `$ARGUMENTS` after stripping any flags, trimmed, is the council's question.

2. **Pre-flight** — for each chosen voter AND the `judge` profile (used by the synthesizer in step 8), call `mcp__zana__zana_get_profile` with `{ "profileId": "<id>" }` to fetch its `systemPrompt` and `displayName`. Batch all calls in a single tool-use block — they are independent. If any voter id is unknown, surface the error and stop. (When auto-rostering, `zana_list_profiles` from step 1 already confirmed the ids exist.)

3. **Announce intent + roster rationale** in one line. For an auto-roster, name the voters and why, e.g. `Auto-roster for a DB-latency question: performance-engineer + backend-dev + architect → judge synthesizer (no security/ux — not raised).` For an explicit roster, just name them, e.g. `Convening council: api-designer + architect + security-reviewer → judge synthesizer.`

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
     Voters:   <comma-separated voter ids>
     Waiting for <N> voter stances before judge synthesis…
   ```

7. **Wait for all voters to complete.** The harness delivers a task-notification per voter; each notification's `result` field contains the voter's final message (stance + rationale). Do NOT poll. Do NOT spawn the synthesizer until all N voters have reported.

8. **Spawn the synthesizer — one tool-use block, foreground (`run_in_background: false`).**
   - `name`: `synthesizer`.
   - `subagent_type`: `general-purpose`.
   - `prompt`: concatenate
     1. The `judge` profile's `systemPrompt` (fetched in pre-flight) — it is purpose-built for adjudication ("pick the position most consistent with the goal, NOT the most popular; weigh dissent seriously"). This makes the native synthesizer's calibration match the daemon path, which also adjudicates with `judge`.
     2. `You are the synthesizer for a council deliberation on: "{{question}}".`
     3. `The {{N}} voters have already reported. Their stances and rationales are pasted verbatim below — do NOT spawn anything, do NOT poll an inbox, synthesize from the text below and return your final report.`
     4. Build a section per voter, in order, formatted as:
        ```
        ==========================================================================
        VOTER <i>: <voterName> — Stance: <APPROVE|CHANGES>
        ==========================================================================
        <verbatim final message from the voter>
        ```
        (Parse the voter's stance from the first `Stance: ...` line of their final message; if absent, infer from the rationale and flag it in the synthesis.)
     5. `Build a synthesis report:`
        - `[CONSENSUS] — points where all voters agree`
        - `[MAJORITY] — points where most voters agree`
        - `[DISSENT] — points raised by a minority, quoted VERBATIM (never paraphrase, never collapse)`
     6. `Compute the verdict from the stance tally:`
        - `All APPROVE → VERDICT: APPROVE`
        - `Majority APPROVE with dissent → VERDICT: APPROVE WITH CONDITIONS`
        - `Majority CHANGES → VERDICT: REJECT`
        - `Tie or no majority → VERDICT: ESCALATED (human required)`
        (As the judge, apply these as guidance, not a mechanical tally — a single well-argued CHANGES that the others didn't engage with can warrant CONDITIONS or ESCALATED even at a numeric majority.)
     7. `Return a single message containing the synthesis report + verdict + verbatim per-voter rationales as your final output.`

9. **Stop.** The synthesizer's return value is the verdict. Native councils don't have a daemon-side audit checkpoint — for replayable, content-addressed deliberation use `mcp__zana__zana_deliberate` directly.

## When to prefer the daemon path

Use `mcp__zana__zana_deliberate` (the slash command does NOT call this — invoke the MCP tool directly) when you need:

- Multi-round convergence (default 2 rounds in the daemon path).
- Content-addressed audit trail (`rationaleHash`, `synthesisHash`, replayable from event log).
- Human-override flow tied to the verdict (`pending_human` routing on dissent / cap hit / `riskTag: "high"`).
- Quorum strictness beyond simple majority (`unanimous`, `<N>`).

The native path is right for "I want N perspectives and a verdict, fast." The daemon path is right for "this decision needs governance."

## Rules

- ALWAYS spawn voters in ONE tool-use block with `run_in_background: true` — parallel review is the point.
- ALWAYS wait for all voter notifications before spawning the synthesizer.
- The synthesizer runs AFTER voters complete, with their rationales injected into its prompt — voters do NOT call `SendMessage` (it isn't reliably reachable from nested `general-purpose` subagents in this harness; final-message capture is the contract).
- The synthesizer carries the `judge` profile's systemPrompt and MUST preserve dissent verbatim. Its prompt enforces this; do not silently weaken it.
- Do NOT call `mcp__zana__zana_deliberate` from this command — that's the daemon path.
- Do NOT pick a verdict at the host level — the synthesizer (judge) is the only voice that emits the verdict.

## Now convene the council on:

$ARGUMENTS
