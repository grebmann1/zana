---
name: zana:autopilot
description: Start a goal-driven autopilot run — loop agents until an evaluator says success criteria are met, or maxIterations is reached.
argument-hint: <goal>
allowed-tools: mcp__zana__zana_autopilot_goal_driven
---

# /zana:autopilot

You are starting a goal-driven autopilot run. Autopilot loops an ordered sequence of agent steps; after each pass an evaluator agent (default `code-reviewer`) judges the result against success criteria. On FAIL the loop restarts from step 0 with prior-step results threaded into each prompt. On PASS the goal is marked `completed`. After `maxIterations` (default 5) without success, the run lands as `exhausted`.

The user's goal is in `$ARGUMENTS`.

## Defaults (friendly)

- **evaluatorProfile**: `code-reviewer` (configured by the `autopilot` module)
- **maxIterations**: `5` (configured by the `autopilot` module)
- **steps**: 1–3 steps. Pick from common profiles such as `architect`, `full-auto-coder`, `test-writer`, `code-reviewer`, `researcher`. Match the shape of the goal:
  - bug-fix style → `[{architect}, {full-auto-coder}, {test-writer}]`
  - small change → `[{full-auto-coder}, {test-writer}]`
  - investigation → `[{researcher}, {architect}]`

If `$ARGUMENTS` is empty, ask the user "What's the goal?" and stop. Do not invoke the tool with an empty goal.

## Workflow

1. **Trim** `$ARGUMENTS`. Treat the entire string as the goal description.

2. **Propose a plan inline** — derive a `title` (short imperative, ≤80 chars), a `criteria` block (1–4 bullet success conditions inferred from the goal), and a `steps` array of 1–3 `{prompt, profile}` objects. Keep step prompts concrete and self-contained — each step is a fresh agent that only sees its prompt plus prior-step results.

3. **Confirm with the user** in one short block:
   ```
   Autopilot plan:
     title:    <title>
     criteria: <one-line summary>
     steps:
       1. <profile> — <prompt summary>
       2. <profile> — <prompt summary>
   Proceed? (or edit any field)
   ```
   Wait for the user to confirm or edit. Do not fire the tool until they say yes.

4. **Tell the user what you're about to do** in one line, e.g. `Starting autopilot: "<title>" (3 steps, evaluator=code-reviewer, maxIterations=5).`

5. **Call the tool** — `mcp__zana__zana_autopilot_goal_driven` with:
   ```
   {
     "title": "<title>",
     "criteria": "<criteria>",
     "steps": [
       { "prompt": "<step 1 prompt>", "profile": "<profile>" },
       ...
     ]
   }
   ```
   The call returns `{ goalId, status: "running" }` immediately. Do NOT block waiting for the goal to finish — autopilot runs asynchronously.

6. **Render the kickoff** in the format below.

## Output format

```
> /zana:autopilot <goal>

Autopilot started.
  goalId:  <goalId>
  title:   <title>
  steps:   <n> (profiles: a, b, c)
  status:  running

Poll progress:    /zana:autopilot:status <goalId>
List active:      /zana:autopilot:list running
Cancel:           /zana:autopilot:cancel <goalId>
```

## Rules

- Do NOT auto-poll or block on the goal. Hand the `goalId` back and stop.
- Do NOT skip the confirmation step — autopilot spawns real agents and burns iterations.
- Quote the user's goal verbatim into the `title`/`criteria` where reasonable; do not paraphrase the intent.
- Use the friendly defaults unless the user explicitly overrides steps / evaluator / iterations in their prompt.

## Now run autopilot on:

$ARGUMENTS
