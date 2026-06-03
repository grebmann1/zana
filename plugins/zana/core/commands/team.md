---
name: zana:team
description: Spawn a curated Zana team via native Agent + SendMessage — reads the template, spawns subagents in-session, no daemon orchestrator.
argument-hint: <teamId> <prompt>
allowed-tools: Agent SendMessage mcp__zana__zana_list_teams mcp__zana__zana_get_team mcp__zana__zana_get_profile
---

# /zana:team

Spawn a curated Zana team **inside this Claude Code session**. The team template defines the worker roster and the handoff order; you supply the prompt the team will work on. The host conversation IS the orchestrator — there is no daemon-side orchestrator process.

For headless / CI / scheduled use of the same templates, the daemon path remains available via `mcp__zana__zana_start_team` (do NOT call it from this command).

`$ARGUMENTS` is `<teamId> <prompt...>`.

## Workflow

1. **Parse** `$ARGUMENTS` — split on the first whitespace boundary:
   - `teamId` — first token
   - `prompt` — everything after the first token, trimmed

2. **Discovery path** — if `teamId` is missing OR `$ARGUMENTS` is empty:
   - Call `mcp__zana__zana_list_teams` with `{}`.
   - Render a short table: `id`, `name`, `description` (truncate description to ~80 chars).
   - Tell the user: `Pick a team and re-run with /zana:team <teamId> <prompt>.`
   - Stop. Do not spawn anything.

3. **Pre-flight** (when both `teamId` and `prompt` are present):
   - Call `mcp__zana__zana_get_team` with `{ "teamId": "<teamId>" }`. Response shape: `{ id, name, slots, workerProfileIds, orchestratorProfileId, initialPrompt, rules }`.
   - For each unique `slots[].profileId`, call `mcp__zana__zana_get_profile` with `{ "profileId": "<id>" }` to fetch `{ systemPrompt, displayName, description, allowedTools }`. Batch these calls in a single tool-use block — they are independent.
   - Render a one-block summary so the user sees what's about to spawn:
     - Team `name` and `id`
     - For each slot: `<quantity>× <profileId>` (e.g. `1× architect`, `2× backend-dev`)
     - Total agent count = sum of `slots[].quantity`
     - One-line announcement, e.g. `Spawning native team "<teamId>": N subagents in this session.`

4. **Build the spawn plan locally** — DO NOT call `mcp__zana__zana_start_team`. Instead, render each slot to a named `Agent` invocation:

   - **Naming**: for `slots = [{profileId: "architect", quantity: 1}, {profileId: "backend-dev", quantity: 2}]` use names `architect`, `backend-dev`, `backend-dev-2`. First instance keeps the bare profileId; subsequent instances append `-2`, `-3`, etc.
   - **Subagent type mapping** — Zana profile ids don't map 1:1 to Claude Code's built-in `subagent_type` set. Use this static map; default unmapped to `general-purpose`:
     - `architect` → `Plan`
     - `researcher` → `general-purpose`
     - `code-reviewer`, `security-reviewer` → `general-purpose`
     - `debugger` → `general-purpose`
     - `frontend-dev`, `backend-dev`, `full-auto-coder` → `general-purpose`
     - `test-writer`, `doc-generator`, `ux-designer`, `performance-engineer` → `general-purpose`
     - anything else → `general-purpose`

     The Claude Code subagent_type is just the carrier — the *role* comes from the prompt below.
   - **Per-agent prompt** — concatenate, in this order:
     1. Role banner: `You are the {{displayName}} on team "{{team.name}}". Your name in this session is "{{agentName}}".`
     2. The Zana profile's `systemPrompt` (from `zana_get_profile`).
     3. The team's `initialPrompt` as *intent* — prefix it with: `Team workflow (intent):` so the worker knows it describes the overall plan, not its own private task.
     4. The user's prompt verbatim, prefixed `User task:`.
     5. **Handoff instructions** (this is the critical native-team bit):
        - Tell the agent its position in the pipeline ("you are step 2 of 4").
        - Name the *exact* agent name to `SendMessage` to when done (or list of names for fan-out).
        - Tell the last agent in the chain to summarize results back to the user via its return message — no `SendMessage` needed at the tail.
     6. The boilerplate: `When you finish your part, call SendMessage({ to: "<next>", summary: "<one-line>", message: "<context payload>" }) so the next agent can pick up. Do not poll status; do not wait.`
   - **Pipeline detection from `initialPrompt`** — every built-in template's `initialPrompt` already names the order ("Spawn the Architect FIRST", "Spawn the UX Designer in parallel with the Backend Developer", etc.). Use that ordering literally to decide who messages whom. If the initialPrompt is empty or ambiguous, default to the order in `slots[]` — first slot kicks off, each subsequent slot's instances are notified by the previous slot's last instance.

5. **Spawn — one tool-use block, all agents at once.** Issue every `Agent` call in a single message with `run_in_background: true`. Then issue exactly one `SendMessage` to the **first** agent in the pipeline, summary `"kickoff"`, message = the user's prompt + a reminder that downstream agents are already spawned and waiting.

   Example shape (illustrative, names depend on template):
   ```
   Agent({ name: "architect", subagent_type: "Plan", run_in_background: true,
           prompt: "<role banner + systemPrompt + intent + user task + handoff: SendMessage to 'backend-dev' when done>" })
   Agent({ name: "backend-dev", subagent_type: "general-purpose", run_in_background: true,
           prompt: "<... wait for architect's SendMessage; when done SendMessage to 'backend-dev-2'>" })
   Agent({ name: "backend-dev-2", subagent_type: "general-purpose", run_in_background: true,
           prompt: "<... wait for backend-dev's SendMessage; when done SendMessage to 'test-writer'>" })
   Agent({ name: "test-writer", subagent_type: "general-purpose", run_in_background: true,
           prompt: "<... wait for backend-dev-2's SendMessage; when done, summarize back to user>" })

   SendMessage({ to: "architect", summary: "kickoff", message: "<user prompt>" })
   ```

6. **Render the launch summary** — one short block listing:
   - Team `name` (`teamId`)
   - The pipeline as `architect → backend-dev → backend-dev-2 → test-writer` (or fan-out variant — render with commas: `architect → (designer, backend-dev) → frontend-dev`)
   - One-line note: `Agents are running in the background. They will message back as they complete. Use Claude Code's native /agents controls to inspect or stop them — /zana:team:stop is a no-op for native teams.`

7. **Stop.** Do not poll, do not call status. The host conversation owns the loop from here — agents will message back via `SendMessage` and surface their own results.

## Rules

- If `teamId` is unknown/missing, ALWAYS list teams first — never guess an id.
- Pass the user's prompt through verbatim. Do not paraphrase or "improve" it.
- ALWAYS spawn every agent in ONE tool-use block. Sequential `Agent` calls defeat parallel pipelines.
- ALWAYS use `run_in_background: true` so the host conversation can keep going.
- Do NOT call `mcp__zana__zana_start_team`. That tool is reserved for headless/CI callers.
- Do NOT call `mcp__zana__zana_spawn_agent`. That spawns a daemon-side `claude` subprocess — not what we want inside Claude Code.
- Do NOT poll `zana_team_status` or `zana_list_running_teams` after spawning — native teams don't appear there.

## Now run on:

$ARGUMENTS
