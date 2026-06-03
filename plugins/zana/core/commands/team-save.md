---
name: zana:team:save
description: Create or update a team template — curated roster of profiles + slot counts + workflow intent. The new template can then be spawned by /zana:team.
argument-hint: <description of the team you want>
allowed-tools: mcp__zana__zana_list_profiles mcp__zana__zana_list_teams mcp__zana__zana_get_team mcp__zana__zana_save_team
---

# /zana:team:save

Create a new team template (or update an existing one). Templates are stored under `~/.zana/teams/<id>.json` and become available to `/zana:team` and `/zana:team:list` immediately.

`$ARGUMENTS` is a free-text description of what the user wants the team to do. It can be empty.

## Workflow

1. **Discovery** — call `mcp__zana__zana_list_profiles` with `{}` to load the available role profiles. The user's team must be composed only of these profile ids.

2. **If `$ARGUMENTS` is empty**, ask the user:
   - What is the team's purpose? (one sentence)
   - Which roles should it include and how many of each? (offer the profiles list as menu)
   - Pipeline order? (who runs first, who messages whom)
   Stop after gathering. Do not save until they confirm.

3. **If `$ARGUMENTS` is non-empty**, propose a draft team derived from it:
   - Pick a `name` and a kebab-case `id` from the description (e.g., "iOS feature squad" → `id: "ios-feature-squad"`).
   - Pick an `icon` (single emoji, default `🏗️`).
   - Compose `slots` from the profiles list — match capabilities to the description. Quantity is 1 unless parallelism clearly helps (e.g., 2× backend-dev for split workstreams). Cap quantity at 5 unless the user asks for more.
   - Write a tight `initialPrompt` that names the workflow intent: who runs first, dependencies, who reports back. Keep it under 8 lines. This is consumed by `/zana:team`'s native renderer to derive `SendMessage` handoffs.
   - Set `rules.maxConcurrentWorkers = sum(slots[].quantity)`.
   - Default `orchestratorProfileId: "orchestrator"` (used by the daemon path; native path ignores it).
   - Render the draft as a JSON-shaped block so the user can see it.

4. **Confirm** — show the draft and ask: "Save this team? Reply 'yes' to save, or describe changes." Iterate if changes are requested. Do not save without explicit confirmation.

5. **Save** — call `mcp__zana__zana_save_team` with `{ "team": <draft object> }`. On `{ ok: true, id, name }`:
   - Echo the id and name.
   - Tell the user: `Spawn it with /zana:team <id> <prompt> or list all templates with /zana:team:list.`

6. **Update path** — if the user names an existing team id (or `/zana:team:list` is checked first and they pick one), call `mcp__zana__zana_get_team` to load the current shape, edit only the fields the user changed, and pass the full object back through `zana_save_team`. The store treats `id`-bearing payloads as updates.

## Validation

- Every `slots[].profileId` MUST appear in the `zana_list_profiles` response. Reject with a clear error if not — never invent profile ids.
- `slots[].quantity` MUST be an integer ≥ 1. The store clamps to [1, 10] but reject anything outside [1, 5] in this command unless the user explicitly asks for more, since large teams rarely outperform smaller focused ones.
- `id` MUST be kebab-case `[a-z0-9-]+`. The store sanitizes but warn the user if the proposed id was changed.
- `initialPrompt` SHOULD describe pipeline order. Empty `initialPrompt` is allowed but warn the user that `/zana:team` will fall back to `slots[]` order.

## Rules

- Never auto-save. Always confirm with the user before calling `zana_save_team`.
- Never invent profileIds. Use only what `zana_list_profiles` returns.
- Pass-through the user's description into `initialPrompt` only if it actually describes a workflow — otherwise rewrite it as a workflow.
- Do NOT call `zana_start_team` or `zana_spawn_agent` from this command. Saving is read/write template config only.

## Now run on:

$ARGUMENTS
