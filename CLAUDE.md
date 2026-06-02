# Zana — Claude Code Configuration

Zana is a multi-agent orchestrator for Claude Code: a long-lived daemon exposing
an MCP server so a single conversation can spawn, supervise, and synthesize the
work of many specialized worker agents.

## Rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary — prefer editing existing files
- NEVER create documentation files unless explicitly requested
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or `.env` files
- Keep files under 500 lines
- Validate input at system boundaries — trust internal code

## Repo layout

TypeScript monorepo. All work happens under `packages/` and `plugins/`.

| Path | What |
|---|---|
| `packages/core` | Engine: agents, profiles, scheduling, workspace context, daemon (`bin/daemon.ts`) |
| `packages/work` | Tickets, teams, runs, deliberation, checkpoint store |
| `packages/mcp` | MCP server — surfaces Zana primitives as `mcp__zana__*` tools |
| `packages/server` | HTTP/IPC surface (hook server + REST) |
| `packages/intelligence` | Task router, GOAP planner, vector memory, background workers |
| `packages/extras` | Settings, skills, plugin loader |
| `packages/swarm` | Multi-daemon coordination |
| `plugins/zana/core` | Slash commands + skills shipped as `zana@zana-marketplace` |
| `plugins/zana/loop` | Daemon-free `/loop`-driven scheduling, shipped as `zana-loop@zana-marketplace` |
| `.zana/` | Workspace state (gitignored): `tickets/`, `runs/`, `checkpoints/`, `scheduler/`, `events/`, `artifacts/` |
| `scripts/diagnostics/` | Real-Claude smoke tests (cost real money — run sparingly) |

Tests live in `packages/<pkg>/test/`. Build artifacts in `packages/<pkg>/dist/`.

## Build & test

```bash
npm run -w @zana-ai/<pkg> build      # build one package
cd packages/<pkg> && npx vitest run  # test one package
npm run build && npm test             # full sweep before committing
```

After editing TS in `packages/<pkg>/src/`, rebuild that package — production
code paths in other packages reach it via `require("@zana-ai/<pkg>")` which
resolves to `dist/`.

## Workspace context — tenant isolation invariant

Every project-local path resolves through `packages/core/src/project/workspace-context.ts`.
The singleton must be initialized once on app/script start:

```js
core.project.workspaceContext.init(workspaceRoot);
```

Project-local stores (`tickets`, `runs`, `checkpoints`, `scheduler`, etc.)
ALWAYS go through `getProjectPaths()`. Adding a new project-local dir means
adding it to BOTH branches of `getProjectPaths()` (singleton + `createForWorkspace`
factory) and consuming it via the workspace-context lookup, NOT by joining
paths from the workspace root in the calling module.

Tenant-isolated writes (CAS artifacts, `kind: "deliberation"` checkpoints) MUST
refuse to fall back to `~/.zana/`. The fallback is shared across every
workspace on the host — landing a deliberation record there silently mixes
state across workspaces. Use `WorkspaceNotInitializedError` to refuse.

## Agent comms — SendMessage-first

Named agents coordinate via `SendMessage`, not polling or shared state.

```
Lead (you) ←→ architect ←→ coder ←→ tester ←→ reviewer
              (named agents message each other directly)
```

Spawn the whole team in ONE message; each agent's prompt names who to message
next.

```javascript
Agent({ prompt: "Research the codebase. SendMessage findings to 'architect'.",
  subagent_type: "researcher", name: "researcher", run_in_background: true })
Agent({ prompt: "Wait for 'researcher'. Design solution. SendMessage to 'coder'.",
  subagent_type: "system-architect", name: "architect", run_in_background: true })
Agent({ prompt: "Wait for 'architect'. Implement it. SendMessage to 'tester'.",
  subagent_type: "coder", name: "coder", run_in_background: true })
Agent({ prompt: "Wait for 'coder'. Write tests. SendMessage results to 'reviewer'.",
  subagent_type: "tester", name: "tester", run_in_background: true })
Agent({ prompt: "Wait for 'tester'. Review code quality and security.",
  subagent_type: "reviewer", name: "reviewer", run_in_background: true })

SendMessage({ to: "researcher", summary: "Start", message: "[task context]" })
```

| Pattern | Flow | When |
|---|---|---|
| **Pipeline** | A → B → C → D | Sequential dependencies (feature dev) |
| **Fan-out** | Lead → A, B, C → Lead | Independent parallel work (research) |
| **Supervisor** | Lead ↔ workers | Ongoing coordination (complex refactor) |

Rules:
- Always `name:` agents so they're addressable
- Always include comms instructions in prompts
- Spawn ALL agents in one message with `run_in_background: true`
- After spawning: STOP, tell the user what's running, wait for results
- NEVER poll status — agents message back when done

## When to swarm

- **YES**: 3+ files, new features, cross-module refactors, API changes, security/perf reviews
- **NO**: single file edits, 1-2 line fixes, doc tweaks, config changes, questions

## MCP tool surface (Zana)

Discover with `ToolSearch("zana <keyword>")`. All Zana tools are namespaced
`mcp__zana__zana_*`.

| Domain | Representative tools |
|---|---|
| **Agents** | `zana_spawn_agent`, `zana_list_agents`, `zana_kill_agent`, `zana_agent_status` |
| **Teams** | `zana_start_team`, `zana_get_team`, `zana_team_status`, `zana_stop_team` |
| **Tickets** | `zana_ticket_create`, `zana_ticket_claim`, `zana_ticket_complete`, `zana_ticket_list` |
| **Sprints** | `zana_sprint_create`, `zana_sprint_start`, `zana_sprint_board` |
| **Deliberation** | `zana_deliberate`, `zana_deliberate_cancel`, `zana_deliberation_status` |
| **Autopilot** | `zana_autopilot_goal_driven`, `zana_autopilot_goal_status`, `zana_autopilot_goal_cancel` |
| **Schedules** | `zana_schedule_list`, `zana_schedule_trigger`, `zana_schedule_reload` |
| **Memory** | `zana_memory_store`, `zana_memory_search` |
| **Events** | `zana_event_emit`, `zana_event_query`, `zana_publish_channel`, `zana_subscribe_channel` |
| **Artifacts** | `zana_artifact_create`, `zana_artifact_read`, `zana_artifact_list` |

Slash commands are shipped through two plugins under `plugins/zana/{core,loop}`
and installed as `zana@zana-marketplace` and `zana-loop@zana-marketplace`.

## Runtime adapter

`ZANA_RUNTIME` selects how worker agents are spawned:

- `claude-spawn` (default) — mirrors Claude Code's own `Task` spawn
- `vercel-ai` (experimental, Phase 3) — Vercel AI SDK dispatcher

Profiles, tickets, deliberation, and the MCP surface stay identical regardless
of runtime — that's the seam.

## Scheduling

One YAML schema, two paths:

- **Daemon path** (heavyweight): `cron` or `every`, daemon-driven, full history.
  Drop `<id>.yml` in `.zana/scheduler/`, run `/zana:schedule:reload`.
- **Loop path** (lightweight, daemon-free): same yml file, driven by Claude
  Code's built-in `/loop` skill via `/zana:loop:start <id>`. `cron` is daemon-only.

Schema doc: `plugins/zana/loop/skills/scheduler/SKILL.md`.

## Things to remember

- Don't add features, fallbacks, or backwards-compat shims that aren't asked for
- The `init()` function on `packages/work/src/runs/checkpoint/store.ts` is for
  tests — production code should rely on workspace-context resolution
- `~/.zana/` is the GLOBAL fallback for an uninitialized workspace; never use
  it for tenant-isolated state
- `scripts/diagnostics/run-real-deliberation*.js` calls real Claude and costs
  real money — don't run unless explicitly asked
