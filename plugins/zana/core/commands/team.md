---
name: zana:team
description: Spawn a curated Zana team — orchestrator plus worker slots — to run a prompt. Picks profiles from the team template; you supply the task.
argument-hint: <teamId> <prompt>
allowed-tools: mcp__zana__zana_list_teams mcp__zana__zana_get_team mcp__zana__zana_start_team
---

# /zana:team

Spawn a curated team. The team template defines the orchestrator profile and worker slots; you supply the prompt the team will work on.

`$ARGUMENTS` is `<teamId> <prompt...>`.

## Workflow

1. **Parse** `$ARGUMENTS` — split on the first whitespace boundary:
   - `teamId` — first token
   - `prompt` — everything after the first token, trimmed

2. **Discovery path** — if `teamId` is missing OR `$ARGUMENTS` is empty:
   - Call `mcp__zana__zana_list_teams` with `{}`.
   - Render a short table: `id`, `name`, `description` (truncate description to ~80 chars).
   - Tell the user: `Pick a team and re-run with /zana:team <teamId> <prompt>.`
   - Stop. Do not call `zana_start_team`.

3. **Pre-flight** (when both `teamId` and `prompt` are present):
   - Call `mcp__zana__zana_get_team` with `{ "teamId": "<teamId>" }`.
   - Render a one-block summary so the user sees what's about to spawn:
     - Orchestrator profile id
     - Worker slots — for each slot: profile id and slot count
     - Total agent count (1 orchestrator + sum of worker counts)
   - One-line announcement, e.g. `Starting team "<teamId>": 1 orchestrator + N workers.`

4. **Start** — call `mcp__zana__zana_start_team` with:
   ```
   {
     "teamId": "<teamId>",
     "prompt": "<trimmed prompt>"
   }
   ```
   Omit `cwd` unless the user explicitly named a working directory in their prompt.

5. **Render the launch result** (the tool returns `{ ok: true, orchestratorAgentId, terminalId }` on success, or `{ ok: false, error }` on failure):
   - `teamId` (echoed)
   - `orchestratorAgentId` — the primary handle for the run
   - `terminalId` if present
   - Worker agents are not part of this response — they are spawned later by the orchestrator. Refer the user to `/zana:team:status <teamId>` to see workers as they appear.
   - Reminder line: `Poll progress with /zana:team:status <teamId>. Stop the team with /zana:team:stop <teamId>.`
   - On `{ ok: false, error }` — surface the error verbatim and stop.

## Rules

- If `teamId` is unknown/missing, ALWAYS list teams first — never guess an id.
- Do NOT poll status from inside this command. Spawning is one-shot; the user owns follow-up.
- Pass the user's prompt through verbatim. Do not paraphrase or "improve" it.
- Do NOT call `zana_stop_team` from this command.

## Now run on:

$ARGUMENTS
