---
name: zana:autopilot:discover
description: Walk a fuzzy goal through a structured discovery pass — clarifying questions, falsifiable criteria, concrete steps — then hand the resolved plan to /zana:autopilot.
argument-hint: <fuzzy goal>
allowed-tools: mcp__zana__zana_memory_search, mcp__zana__zana_list_profiles, mcp__zana__zana_autopilot_goal_driven
---

# /zana:autopilot:discover

You are running the **discovery phase** for an autopilot goal. Autopilot's success is bounded by the quality of the goal, criteria, and steps; if any are fuzzy the loop will exhaust five iterations producing nothing. Your job is to extract a fully concrete plan from the user *before* invoking `zana_autopilot_goal_driven`.

The user's fuzzy goal is in `$ARGUMENTS`.

If `$ARGUMENTS` is empty, ask the user "What's the goal?" and stop.

## Workflow

### 1. Memory pre-flight

Call `mcp__zana__zana_memory_search` with the user's goal text (no rephrasing). Limit 3.

```
zana_memory_search({ query: "<$ARGUMENTS>", limit: 3 })
```

If a similar prior goal exists in memory, mention it briefly to the user ("I see a similar goal succeeded last week — same approach?") and lift its criteria-shape and step profiles. Do not silently reuse — surface the match so the user can confirm.

If memory is empty, proceed without comment.

### 2. Discovery questions

Ask the user up to 4 clarifying questions, in this order. **Stop asking as soon as the goal is concrete enough to invoke autopilot.** Skip any question whose answer is already obvious from `$ARGUMENTS`.

Ask them as a **single message with all questions at once**, not one at a time — the user's flow matters more than the protocol.

Q1. **Falsifiable criteria.** "How do we tell we're done? A test passing, a metric below a threshold, a regex-style absence — something the evaluator agent can check by reading the next iteration's output. 'Looks good' isn't enough."

Q2. **Scope.** "Which paths or packages should we touch? And what's *out of scope* — what should the worker NOT modify?"

Q3. **Conventions / constraints.** "Anything specific to match — test framework, error-handling style, a sibling implementation to follow, an API contract to preserve?"

Q4. **Step shape.** "Does this look like:
- (a) **research → implement → test** (default for change-the-code goals),
- (b) **research → architect → implement → test** (for non-trivial designs), or
- (c) **research-only** (gather, summarize, no mutation)?
A different shape if you know what you want."

If the user gave enough information up front, ask only the questions you actually need answered. **Quality > quantity.**

### 3. Profile resolution

Once you know the step shape, call `mcp__zana__zana_list_profiles` if you're unsure which profiles are available (look for `researcher`, `architect`, `full-auto-coder`, `backend-dev`, `frontend-dev`, `test-writer`, `code-reviewer`, `judge`, etc.).

Pick one profile per step. Don't pre-specify *how* the step solves the problem; specify *what* it must produce (file lists, JSON outputs, a code change, a test).

### 4. Echo the resolved plan back

Render the plan to the user in the exact format below. **Wait for explicit confirmation** ("yes", "go", "proceed") before invoking the tool. If they edit any field, integrate the edit and re-confirm.

```
Autopilot plan (post-discovery):
  title:    <one-line imperative, ≤80 chars>
  criteria: <falsifiable success conditions, 1-4 lines>
  steps:
    1. <profile> — <prompt summary>
    2. <profile> — <prompt summary>
    3. <profile> — <prompt summary>
  scope:
    in:  <paths the workers may touch>
    out: <paths the workers must not touch>

Memory: <"matched prior goal X" | "no prior context">
Proceed? (or edit any field)
```

### 5. Invoke autopilot

Once confirmed, call `mcp__zana__zana_autopilot_goal_driven` with `{ title, criteria, steps }`. Bake the in-scope/out-of-scope hints into each step's prompt (the tool itself has no scope field; the worker only sees what the prompt tells it).

The call returns `{ goalId, status: "running" }`. Hand the `goalId` back to the user and stop.

## Output format

```
> /zana:autopilot:discover <fuzzy goal>

Discovery complete.
  goalId:  <goalId>
  title:   <title>
  steps:   <n> (profiles: a, b, c)
  status:  running

Poll progress:    /zana:autopilot:status <goalId>
List active:      /zana:autopilot:list running
Cancel:           /zana:autopilot:cancel <goalId>
```

## Rules

- Do NOT skip the discovery questions — that's the whole point of this command. If the user wants to skip discovery, they should use `/zana:autopilot` directly.
- Do NOT invoke `zana_autopilot_goal_driven` until the user has confirmed the echoed plan.
- Do NOT silently apply memory matches — surface them.
- Ask all clarifying questions in ONE message, not one at a time.
- Quote the user's own words verbatim into `title`/`criteria` where reasonable.
- Use the friendly defaults from `/zana:autopilot` (3 steps max, 1–3 profiles).
- After kickoff, do NOT poll or block — hand back the `goalId` and stop.

## Now run discovery on:

$ARGUMENTS
