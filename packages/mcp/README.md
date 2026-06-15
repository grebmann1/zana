# @zana-ai/mcp

The Zana MCP server. Exposes Zana's orchestration primitives — agents,
teams, tickets, sprints, schedules, deliberation, autopilot, swarm — as
MCP tools that any MCP-aware client (Claude Code, Claude Desktop, etc.)
can call.

If you only want to *use* Zana from Claude Code with no source clone,
this is the only package you need to install.

## Install

```bash
npm install -g @zana-ai/mcp
```

This installs two binaries on your PATH:

- `zana` — top-level CLI dispatcher (`zana --help`)
- `zana-daemon` — long-lived process serving the MCP tools

## Register with Claude Code

After install:

```bash
claude mcp add --scope user zana zana-mcp-server
```

Then in any workspace:

```bash
zana headless . --background    # start the daemon (port 47402)
```

### Workspace resolution — set `ZANA_WORKSPACE` per project

Tickets, sprints, runs, checkpoints, and every other project-local store
live under the active workspace's `.zana/` directory, and isolation between
projects depends entirely on the server resolving the **right** workspace.

The server picks its workspace in this order:

1. **`ZANA_WORKSPACE`** env var — the explicit, recommended setting.
2. **`process.cwd()`** — the launching process's working directory, which
   Claude Code sets to the active project. This is the safety-net fallback.

For a single global `--scope user` registration shared across many projects,
**set `ZANA_WORKSPACE` per project** so there is no ambiguity. The simplest
way is a project-scoped registration that pins it:

```bash
# Run from inside the project directory:
claude mcp add --scope local zana zana-mcp-server \
  --env ZANA_WORKSPACE="$PWD"
```

Or, equivalently, in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "zana": {
      "command": "zana-mcp-server",
      "env": { "ZANA_WORKSPACE": "/absolute/path/to/your/project" }
    }
  }
}
```

If `ZANA_WORKSPACE` is unset, the server falls back to its launch `cwd`. That
is correct whenever the client launches the server from the project root (as
Claude Code does), but the env var removes all doubt — and is required for any
launcher that does not control `cwd`. The server prints its chosen workspace at
startup: `[zana-mcp] booting core in-process for: <path>` — check it if tickets
seem to be landing in the wrong place.

In a Claude Code session the `mcp__zana__zana_*` tools are now
available. Discover them with:

- `ToolSearch("zana <keyword>")` — surface deferred tool schemas
- `mcp__zana__zana_list_profiles` — built-in agent roles
- `mcp__zana__zana_list_teams` — curated team templates

## Tool surface

96 tools across these domains (see
[`docs/MCP-TOOL-REFERENCE.md`](../../docs/MCP-TOOL-REFERENCE.md) for the
full schema reference):

| Domain | Examples |
|---|---|
| Agents | `zana_spawn_agent`, `zana_list_agents`, `zana_kill_agent` |
| Teams | `zana_list_teams`, `zana_start_team`, `zana_team_status` |
| Tickets | `zana_ticket_create`, `zana_ticket_claim`, `zana_ticket_complete` |
| Sprints | `zana_sprint_create`, `zana_sprint_start`, `zana_sprint_board` |
| Deliberation | `zana_deliberate`, `zana_deliberation_status`, `zana_deliberation_nudge` |
| Autopilot | `zana_autopilot_goal_driven`, `zana_autopilot_goal_status` |
| Schedules | `zana_schedule_list`, `zana_schedule_trigger`, `zana_schedule_reload` |
| Memory | `zana_memory_store`, `zana_memory_search` |
| Artifacts | `zana_artifact_create`, `zana_artifact_read` |

## Native vs daemon path

For most chat-based work, prefer the **native plugin**
(`zana@zana-marketplace`) — slash commands like `/zana:team`,
`/zana:council`, and `/zana:autopilot` rewrite the work into Claude
Code's first-class `Agent` + `SendMessage` primitives with no daemon
round-trip.

The daemon path (this package) is for headless / CI / cron use cases
where work must outlive any chat session, or for multi-daemon swarms.

## Build & test

```bash
npm run -w @zana-ai/mcp build
cd packages/mcp && npx vitest run
```

After editing tool schemas or adding new tools, regenerate the doc
reference:

```bash
npm run docs:mcp-ref
```

## See also

- Top-level [README](../../README.md) — paths, getting started,
  installation
- [`INSTALL.md`](../../INSTALL.md) — step-by-step install incl.
  marketplace + MCP registration
- [`@zana-ai/core`](../core) — the engine this server wraps
