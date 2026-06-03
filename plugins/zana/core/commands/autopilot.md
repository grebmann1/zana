---
name: zana:autopilot
description: Native goal-driven autopilot — ordered Agent steps + evaluator, looping until criteria pass or maxIterations is hit.
argument-hint: <goal>
allowed-tools: Agent SendMessage mcp__zana__zana_get_profile
---

# /zana:autopilot

Run a goal-driven autopilot **inside this Claude Code session** as a native loop: the host conversation orchestrates an ordered chain of `Agent` steps followed by an evaluator `Agent`. The evaluator emits `VERDICT: PASS` or `VERDICT: FAIL`. On FAIL the host re-spawns the chain with prior-iteration results threaded into prompts. On PASS the host stops and reports back. After `maxIterations` (default 5) without success, the host stops as `exhausted`.

For headless / CI / scheduled autopilot with daemon-side persistence and an in-process evaluator that survives Claude Code session ending, the daemon path remains available via `mcp__zana__zana_autopilot_goal_driven` (do NOT call it from this command).

The user's goal is in `$ARGUMENTS`.

## Defaults (friendly)

- **evaluatorProfile**: `code-reviewer`
- **maxIterations**: 5
- **steps**: 1–3 chosen by goal shape:
  - bug-fix → `[architect, full-auto-coder, test-writer]`
  - small change → `[full-auto-coder, test-writer]`
  - investigation → `[researcher, architect]`

If `$ARGUMENTS` is empty, ask the user "What's the goal?" and stop.

## Workflow

1. **Propose plan inline** — derive `title` (≤80 chars), a `criteria` block (1–4 falsifiable bullets), and `steps[] = [{profile, prompt}, ...]`. Each step prompt should be concrete and self-contained — agents only see their own prompt plus prior-step results threaded in by the host.

2. **Pre-flight profile fetch** — for each unique step profile + the `evaluatorProfile`, call `mcp__zana__zana_get_profile` to fetch `systemPrompt` and `displayName`. Batch in one tool-use block.

3. **Confirm with the user** in one short block:
   ```
   Autopilot plan (native):
     title:    <title>
     criteria: <one-line summary>
     steps:
       1. <profile> — <prompt summary>
       2. <profile> — <prompt summary>
     evaluator: <evaluatorProfile>
     maxIterations: <n>
   Proceed? (or edit any field)
   ```
   Wait for confirmation. Do NOT spawn until the user says yes.

4. **Iteration 1** — spawn ALL step agents + the evaluator in ONE tool-use block:

   - **Step agents** (`run_in_background: true`, named `step-1`, `step-2`, ...):
     - Each agent's prompt = role banner + profile `systemPrompt` + step-specific prompt + `When done, call SendMessage({ to: "<next-step-name or evaluator>", summary, message: "<results + brief context for next step>" }) and stop.`
     - Last step's `to:` is `evaluator`.

   - **Evaluator agent** (`run_in_background: true`, name `evaluator`):
     - Prompt: role banner + evaluator profile `systemPrompt` + the `criteria` block + `Wait for SendMessage from "step-<last>" with the iteration's results. Then judge against the criteria and emit a single line VERDICT: PASS or VERDICT: FAIL with a one-paragraph rationale. Return your verdict in your final message — do not SendMessage.`

   Then issue ONE kickoff `SendMessage({ to: "step-1", summary: "iteration 1 kickoff", message: "<user goal verbatim + criteria>" })`.

5. **Read the evaluator's verdict** — when the evaluator returns its message:
   - On `VERDICT: PASS`: render the goal as `completed`, summarize the steps' outputs, stop.
   - On `VERDICT: FAIL` and `iteration < maxIterations`: announce `Iteration N failed: <evaluator rationale one-liner>. Starting iteration N+1.` Re-spawn the same step + evaluator agents (use suffixed names like `step-1-i2`, `step-2-i2`, `evaluator-i2`) with the previous iteration's results threaded into each step's prompt. Issue a new kickoff `SendMessage`.
   - On `VERDICT: FAIL` and `iteration === maxIterations`: render `exhausted` — list iteration outcomes, the latest evaluator rationale, and recommend either tightening `criteria` or running the daemon path for persistent retries.

6. **Render the final result** in the format below.

## Output format

```
> /zana:autopilot <goal>

Autopilot started (native, in-session).
  title:    <title>
  steps:    <n>  (profiles: a, b, c)
  evaluator: <profile>
  iteration: <current>/<maxIterations>

(after each iteration's evaluator returns)
Iteration <n>: VERDICT: PASS|FAIL
  rationale: <one-line>

(on completion)
Goal completed in <n> iteration(s).
  final outputs: ...
```

## When to prefer the daemon path

Use `mcp__zana__zana_autopilot_goal_driven` directly when you need:

- The loop to outlive this Claude Code session (daemon-driven persistence).
- Tickets-as-evidence pattern with `zana_ticket_complete` calls embedded in step prompts (the daemon path naturally integrates with the ticket watcher).
- Pre-flight memory lookup via `zana_memory_search` and post-mortem `zana_memory_store` — the daemon path is where these primitives shine.

The native path is right for "iterate-until-done within a single Claude Code session." The daemon path is right for long-running, persistence-critical loops.

## Rules

- ALWAYS confirm the plan with the user before spawning. Autopilot iterations cost real tokens.
- ALWAYS spawn each iteration's step + evaluator agents in ONE tool-use block. Sequential calls break parallel pipelines.
- ALWAYS use `run_in_background: true` so the host can monitor without blocking.
- Do NOT call `mcp__zana__zana_autopilot_goal_driven` from this command — that's the daemon path.
- Do NOT silently retry past `maxIterations` — surface `exhausted` to the user and let them decide.
- Quote the user's goal verbatim into `title` / `criteria` where reasonable; do not paraphrase intent.

## Now run autopilot on:

$ARGUMENTS
