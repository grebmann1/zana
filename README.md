# Zana

Zana is a multi-agent orchestrator for Claude Code, available on **two paths**:

- **Native** (default in chat) — install the plugin (`/plugin install zana@zana-marketplace`), then type `/zana:team`, `/zana:council`, `/zana:autopilot`, etc. Slash commands drive Claude Code's first-class `Agent` + `SendMessage` primitives. No daemon required.
- **Daemon** (headless / CI / cron) — a long-lived process exposing an MCP server (`mcp__zana__zana_*`) for scheduled tasks, autopilot loops, and multi-daemon swarms that must outlive any chat.

Templates, profiles, tickets, sprints, artifacts, and deliberation work the same on both paths.

## Install

The fastest path: install the Claude Code plugin from the GitHub marketplace.
No clone, no build, no daemon.

In a Claude Code session:

```
/plugin marketplace add grebmann1/zana
/plugin install zana@zana-marketplace        # orchestrator (28 commands, 2 skills)
/plugin install zana-loop@zana-marketplace   # lightweight /loop scheduling (3 cmds, 1 skill)
```

Restart Claude Code. Then in any workspace:

```
/zana:team backend-squad "Add a /healthz endpoint"
/zana:council "Should we add a Redis cache?"
/zana:council:arch "Adopt event sourcing here?"   # role-pack preset (NEW in 0.1.4)
/zana:autopilot "Ship the dark-mode toggle"
```

For headless / CI / cron, also install the daemon:

```bash
npm install -g @zana-ai/mcp
```

Step-by-step incl. troubleshooting: [INSTALL.md](./INSTALL.md).

## What Zana is

- Multi-agent orchestrator for Claude Code — native plugin first, daemon for headless
- 31 slash commands across two plugins (`zana@zana-marketplace`, `zana-loop@zana-marketplace`)
- 94 MCP `zana_*` tools (daemon path) for spawning agents, managing tickets/sprints, scheduling, and deliberation
- A standalone CLI (`zana …`) for the daemon path — same primitives, different surface
- Pluggable module system for adding new capabilities without forking the core

## Repository layout (7 packages + 2 plugins)

- `packages/core` — foundational engine (agents, events, project, modules, persistence)
- `packages/work` — work tracking (tickets, scheduling, teams, runs)
- `packages/server` — HTTP/IPC surface (hooks, REST API)
- `packages/swarm` — multi-daemon coordination
- `packages/intelligence` — task routing, GOAP planning, vector memory
- `packages/extras` — settings + plugin loader
- `packages/mcp` — MCP server exposing zana to Claude Code
- `plugins/zana/core` — Claude Code plugin (`/zana`, `/zana:autopilot`, `/zana:council`, etc.)
- `plugins/zana/loop` — Claude Code plugin for lightweight scheduling (`/zana:loop:start|stop|define`, daemon-free)

## Built-ins

- 18 agent profiles in `packages/core/profiles/`: api-designer, architect, backend-dev, code-reviewer, debugger, doc-generator, frontend-dev, full-auto-coder, judge, orchestrator, performance-engineer, researcher, security-reviewer, slack-notifier, swarm-master, swarm-orchestrator, test-writer, ux-designer
- 1 example module in `packages/core/modules/example/`
- Two slash-command plugins in the `zana-marketplace` marketplace: `zana@zana-marketplace` (orchestration + daemon-driven schedules) and `zana-loop@zana-marketplace` (lightweight `/loop`-driven schedules — no daemon required)

## Two ways to run Zana

Zana is the same engine either way; the difference is who issues the commands.

### A. From Claude Code (native plugin)

The default surface. After installing the plugin, in any workspace:

```
/zana <task>                       # free-form orchestrator (spawns Agent + SendMessage)
/zana:team <teamId> <prompt>       # spawn a curated team in-session
/zana:council <question>           # multi-voter deliberation
/zana:autopilot <goal>             # goal-driven loop
/zana:schedule:list                # daemon-driven schedules (requires daemon)
/zana:loop:start                   # daemon-free /loop scheduling
```

31 slash commands across two plugins. See
[plugins/zana/core/commands/](plugins/zana/core/commands/) and
[plugins/zana/loop/commands/](plugins/zana/loop/commands/).

### B. From the terminal (`zana <subcommand>`)

After `bash scripts/install.sh` (which runs `npm install -g .`), the `zana`
binary is on your PATH. Useful for scripting, CI, ops, and any context
where Claude Code isn't running.

```
zana --help
zana init wizard <path>            # bootstrap workspace + register MCP
zana headless . --background       # start daemon (port 47402)
zana status                        # list running daemons
zana ticket list                   # query tickets
zana run list --limit 10           # recent agent runs
zana schedule list                 # YAML schedules in .zana/scheduler/
zana schedule trigger <id>         # fire one schedule now
zana stop --all                    # stop every daemon, clean registry
```

Full subcommand list: `zana --help`. Both binaries — `zana` (top-level
dispatcher) and `zana-daemon` (the long-lived process) — are installed
globally.

## Getting started

Three paths, fastest first:

```bash
# 0. From npm (no clone, no build) — daemon + CLI + MCP server only
npm install -g @zana-ai/mcp

# A. From source (full repo + slash-command plugins)
git clone https://github.com/grebmann1/zana.git && cd zana
bash scripts/install.sh

# B. Manual per-step — see INSTALL.md
```

Full step-by-step (humans + agents): see [INSTALL.md](./INSTALL.md), which
covers prerequisites, manual install, marketplace + MCP registration, daemon
boot, verification, and common failure modes.

Bare-minimum cheat sheet (development, from a clone):

- Install: `npm install`
- Build: `npm run build:runtime`
- Test: `npm test`
- CLI: `node dist/bin/zana.js --help` (or after `npm install -g .`: `zana --help`)
- MCP server entry: `packages/mcp/dist/bin/zana-mcp-server.js`

## Master mode

For multi-daemon setups, set `ZANA_MASTER_MODE=true` to expose the additional `zana_swarm_*` coordination tools. For ordinary single-daemon orchestration, leave it off — the in-process agent tools are sufficient.

## Architecture notes

- Lazy require getters in core's facade break what would otherwise be circular package deps
- All packages declare workspace-relative version `*` — npm workspaces resolves siblings
- Built-in profiles ship in core's `dist/`; user profiles live in `~/.zana/profiles/`

## Status

- Recent work:
  - **0.1.4** — sfdc-council patterns landed: role packs + `/zana:council:arch` preset, generalist-seat invariant in deliberation, mid-deliberation human nudge (`zana_deliberation_nudge`), heterogeneous-model voters per deliberation
  - `zana-loop` plugin: `/zana:loop:start|stop|define` drive `.zana/scheduler/*.yml` via Claude Code's `/loop` — no daemon required
  - Async-by-default `zana_deliberate` — returns immediately, snap-judgment voter prompt cuts latency from ~520s to ~65s, 20-min timeout, `zana_deliberate_cancel`, recovers voter JSON from full transcript
  - Reliability: zombie reaper for orphaned headless agents, load-throttle starvation fix, team-start hard gate
  - Hook-server hardening (Tier 1+2): error propagation, agentId regex, graceful drain, 30s handler timeout, fan-out cap, jq-safe terminal-id injection
  - Scheduler `workflow` and `mcp_tool` actions wired; CLI subcommands + 65 unit tests + reload/history endpoints
  - Opt-in run-history with retain-N policy (`history: { enabled, retain }` in YAML)
  - Event log + audit log size-based rotation (`ZANA_EVENT_LOG_MAX_BYTES`)
  - Structured logger module (`packages/core/src/util/logger.ts`)
  - Hook installer drift detection (re-deploys stale `~/.zana/bin/post-hook.sh` on upgrade)

For deeper docs: `packages/server/README.md` (HTTP surfaces + hook flow), `packages/work/README.md` (scheduler schema), `plugins/zana/core/commands/zana.md` (orchestrator command + diagnostics).

**Slash-command authors:** before writing a render block for any `zana_*` MCP tool, consult [`docs/MCP-TOOL-REFERENCE.md`](docs/MCP-TOOL-REFERENCE.md). It is the source of truth for input schemas, output shapes, enum values, and known field-name landmines (e.g. priority is `critical|high|medium|low`, not `P0|P1|P2|P3`; initial ticket status is `backlog`, not `open`; `zana_start_team` returns `{ ok, orchestratorAgentId, terminalId }` with no `runId`). Regenerate after MCP changes with `npm run docs:mcp-ref`.

## Contributing

PRs welcome. Keep tests at baseline. Use the existing patterns (sed-able identifier renames, lazy require for cycle breaks).
