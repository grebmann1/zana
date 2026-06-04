# Zana — Claude Code Configuration

Zana is a multi-agent orchestrator for Claude Code, with two paths:

- **Native** (default in chat) — a thin layer of slash commands and skills that
  drive Claude Code's first-class `Agent` + `SendMessage` primitives. Spawn,
  coordinate, and synthesize many specialized subagents from a single
  conversation, with no daemon involved.
- **Daemon** (headless / CI / cron) — a long-lived process exposing an MCP
  server (`mcp__zana__zana_*`) for scheduled tasks, autopilot loops, and
  multi-daemon swarms that must outlive any chat.

Templates, profiles, tickets, sprints, artifacts, and deliberation work the
same on both paths.

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

`core ↔ work ↔ extras` form a require-cycle (work needs core for the workspace
context and event bus; extras needs core for profiles; core needs work for
tickets/scheduling and extras for skills). Cycle is intentional and accepted
this sprint — extracting `@zana-ai/contracts` is a future sprint. To keep the
cycle from biting at module-load time, callers reach into the other side via
the typed `lazyRequire<T>()` helper at `packages/core/src/util/lazy-require.ts`,
which fronts the cross-package module behind a `Proxy` and defers `require()`
to first property access. Use it (not raw `new Proxy({}, …)`) for any new
cross-package lazy reference.

**Dist-path consumption.** Consumers OUTSIDE `@zana-ai/core` import
lazyRequire from the dist subpath, not the package root:

```ts
import { lazyRequire } from "@zana-ai/core/dist/src/util/lazy-require";
```

Importing from `"@zana-ai/core"` would resolve the package's main entry,
re-trigger the cycle at module-load time, and defeat the helper's whole
purpose. The dist-subpath import is intentional — do NOT "fix" it back to
the package root. Once `@zana-ai/contracts` is extracted (future sprint)
and core no longer pulls in work/extras at load time, the subpath
workaround can be retired in favor of the package root.

**lazyRequire vs `_core()` per-call helpers.** Roughly 18 ad-hoc
`function _core() { return require("@zana-ai/core"); }` helpers live across
`work/`, `intelligence/`, `server/`, `mcp/`, `extras/` and coexist with
`lazyRequire` in the same files (e.g. `work/src/tickets/db.ts` uses both).
Policy:

- Any NEW cross-package lazy reference SHOULD use `lazyRequire` (typed +
  cached + one canonical implementation).
- Existing `_core()` helpers MAY be migrated opportunistically; they are
  not a merge blocker and need not be ripped out wholesale.

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

## When to spawn a team

- **YES**: 3+ files, new features, cross-module refactors, API changes, security/perf reviews
- **NO**: single file edits, 1-2 line fixes, doc tweaks, config changes, questions

(`packages/swarm/` and the `zana_swarm_*` MCP tools are a separate, advanced primitive — multi-daemon coordination across workspaces. Headless/CI only; not needed inside a Claude Code chat.)

## MCP tool surface (Zana)

Discover with `ToolSearch("zana <keyword>")`. All Zana tools are namespaced
`mcp__zana__zana_*`. The **Path** column tells you when a tool is the right
primitive: **native** = use it inside a Claude Code session in addition to
`Agent`/`SendMessage`; **daemon** = headless / CI / cron only — don't use from
chat; **both** = path-agnostic, works the same either way. Cells that read
"daemon — use `/zana:foo` natively" mean the slash command rewrites the work
into native `Agent`+`SendMessage` calls (no daemon round-trip).

Rows tagged **daemon-only (gated)** are hidden from `tools/list` by default.
Set `ZANA_DAEMON_TOOLS=1` in the MCP server env (alongside `ZANA_MASTER_MODE`
for the swarm tools) to expose them. The default `npx -y @zana-ai/mcp` install
registers ~64 tools; `ZANA_DAEMON_TOOLS=1` adds 24 more, `ZANA_MASTER_MODE=true`
adds 6 swarm tools on top.

| Domain | Representative tools | Path |
|---|---|---|
| **Agents (lifecycle)** | `zana_spawn_agent`, `zana_list_agents`, `zana_kill_agent`, `zana_agent_status`, `zana_oneshot_query` | daemon-only (gated) — use `Agent({ run_in_background: true })` natively |
| **Teams (templates)** | `zana_list_teams`, `zana_get_team`, `zana_save_team`, `zana_delete_team` | both |
| **Teams (lifecycle)** | `zana_start_team`, `zana_team_status`, `zana_stop_team`, `zana_list_running_teams` | daemon-only (gated) — use `/zana:team` natively |
| **Tickets** | `zana_ticket_create`, `zana_ticket_claim`, `zana_ticket_complete`, `zana_ticket_list` | both — work-tracking |
| **Sprints** | `zana_sprint_create`, `zana_sprint_start`, `zana_sprint_board` | both — work-tracking |
| **Deliberation** | `zana_deliberate`, `zana_deliberate_cancel`, `zana_deliberation_status`, `zana_deliberation_nudge`, `zana_deliberation_override` | daemon-only (gated) — use `/zana:council` natively |
| **Autopilot** | `zana_autopilot_goal_driven`, `zana_autopilot_goal_status`, `zana_autopilot_goal_cancel`, `zana_autopilot_goal_list` | daemon-only (gated) — use `/zana:autopilot` natively |
| **P2P agent comms** | `zana_ask_agent`, `zana_check_inbox`, `zana_send_ack` | daemon-only (gated) — use `SendMessage` between named subagents natively |
| **Schedules** | `zana_schedule_list`, `zana_schedule_trigger`, `zana_schedule_reload` | daemon (persistent); see also `/loop` skill for daemon-free recurrences |
| **Memory** | `zana_memory_store`, `zana_memory_search` | both — fuzzy K/V store |
| **Events** | `zana_event_emit`, `zana_event_query`, `zana_publish_channel`, `zana_subscribe_channel` | daemon — `SendMessage` covers native chatter |
| **Artifacts** | `zana_artifact_create`, `zana_artifact_read`, `zana_artifact_list` | both — content-addressed shared blobs |
| **Profiles** | `zana_list_profiles`, `zana_get_profile`, `zana_save_profile`, `zana_delete_profile` | both — role library |
| **Swarm** | `zana_swarm_*` | daemon-only (gated by `ZANA_MASTER_MODE=true`), headless multi-daemon only |

Slash commands are shipped through two plugins under `plugins/zana/{core,loop}`
and installed as `zana@zana-marketplace` and `zana-loop@zana-marketplace`.

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
