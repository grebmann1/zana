# ADR 0012 — Optional Claude Code subagents as a team execution strategy

- **Status:** Accepted
- **Date:** 2026-06-17
- **Relates to:** ADR 0008 (ticket-automation pipeline), ADR 0009 (frozen
  experimental surfaces), the 2026-06-17 Orchestranator architecture review
- **Code:** `packages/core/src/agents/subagent-provisioner.ts`,
  `packages/core/src/modules/config.ts` (`system.executionStrategy`),
  `packages/work/src/teams/manager.ts` (`startTeam` branch)

## Context

Zana spawns **one OS `claude` process per agent**: a team is a lead process
plus N worker processes that coordinate via the `mcp__zana__*` tools and the
event bus (`spawner.ts` / `lifecycle.ts`). The sibling **Orchestranator** app
uses the *other* Claude Code model — it provisions `.claude/agents/*.md`
subagent recipe files into the lead's working directory and runs **one** lead
session that dispatches workers in-process via the `Task` tool's
`subagent_type` (verified against its `AgentProvisioner.swift`).

The user asked whether Zana could *optionally* run teams the Orchestranator way,
toggled from settings. This ADR records the decision and its scope.

## Decision

Add an opt-in **execution strategy** for *team* runs, default off.

1. **`system.executionStrategy: "process" | "subagent"`** (default `"process"`)
   in module config, overridable per-team via `team.executionStrategy`. A
   per-team value always wins over the global default
   (`resolveExecutionStrategy` in `teams/manager.ts`).

2. **`"process"` (default) is unchanged** — one `claude` process per agent.
   This remains the only strategy that supports independent per-agent lifecycle
   (kill/restart/transient-retry), cross-session/daemon-persistent agents, and
   the swarm. Nothing about the default path changed.

3. **`"subagent"` provisions recipes + spawns ONE lead.** `startTeam` branches
   to `startTeamAsSubagents`, which writes one `.claude/agents/<team>__<role>.md`
   per worker profile (via `subagent-provisioner.ts`) and spawns a single lead
   session with a Tier-0 directive listing the dispatchable `subagent_type`s.
   There are **no worker processes** — workers are `Task` tool calls.

4. **The ticket-automation pipeline is ALWAYS process-based**, regardless of
   this setting. Its workers must claim/complete tickets and have independent
   lifecycle (crash recovery per ADR 0011) — exactly what a subagent (a tool
   call inside the lead) cannot do. `executionStrategy` scopes to *teams* only.

5. **Subagent mode refuses worktree isolation.** `.claude/agents/*.md` are
   untracked files; a fresh git worktree starts from a clean tree and would not
   contain them, so the subagents would silently not exist. Orchestranator hits
   this exact wall (PDF §A.6) and runs `--run-mode branch` instead. We refuse
   the combination with a clear error rather than provision into a doomed tree.

## Provisioner mechanics (ported from Orchestranator, then corrected by a live run)

- **Composite slug `<team-slug>-<role-slug>`** is both the filename stem and the
  recipe `name:`/`subagent_type`. Orchestranator joins with `__`, but a
  2026-06-18 live run against `claude` CLI 2.1.181 confirmed the Claude Code spec:
  a subagent `name` must be **lowercase letters and hyphens only — no
  underscores**. So `slug()` emits ONLY `[a-z0-9-]` and we join with a single
  `-`. (The `__` form happened to dispatch anyway — the CLI is lenient — but it
  violates the documented rule, so we don't rely on it.)
- **`zana_stamp` = sha256(body)** detects hand-edits: on re-provision, a file
  whose stored stamp still matches its body is "ours" and is overwritten
  (`updated`); a file whose body no longer hashes to its stamp was edited by a
  human and is preserved (`skipped-hand-edited`). Byte-identical content is a
  no-op (`unchanged`). Claude Code ignores the unknown `zana_stamp` frontmatter
  key gracefully (verified live).
- **The recipe body bakes in everything the worker must obey**, because a
  subagent never sees the lead's `--append-system-prompt`. The ticket-lifecycle
  preamble is intentionally NOT injected (subagents don't claim tickets).
- **Recipes inherit the lead's model (`inheritModel`, default for the team
  path)**: profiles tier to opus, but pinning each recipe to opus silently
  upgraded every dispatched subagent — in the first live run that was the entire
  cost gap (subagent $0.14 vs process $0.066). Omitting `model:` so subagents
  follow the lead/session tier closed the gap to parity (subagent $0.069 vs
  process $0.078 on the confirming run).

## Two load-bearing fixes the live A/B run exposed (and we made)

A live diagnostic (`scripts/diagnostics/run-subagent-vs-process.js --live`,
2026-06-18) ran the SAME engineering task through both strategies. The first run
showed the subagent lead **never delegated** (`dispatchedSubagents: []`). Two
root causes, both now fixed and regression-tested:

1. **The lead must have its implementation tools removed.** With Write/Edit/Bash
   available, the model just did the work itself. The subagent lead now gets the
   same `buildTeamLeadDisallowedTools` restriction the process path applies — the
   built-in `Agent` dispatch tool is never disallowed, so delegation stays open.
2. **The lead must run with a clean MCP surface (`strictMcpConfig: true`).**
   Without `--strict-mcp-config` the spawned child inherits the host's MCP
   servers; in the run the inherited cockpit task tools (`TaskCreate`/`TaskUpdate`)
   *shadowed* the built-in dispatch tool and the lead grabbed those instead.
   Pinning the lead to only the zana MCP config makes the dispatch tool the
   one it uses.

After both fixes the confirming run delegated correctly:
`dispatchedSubagents: [eng-smoke-backend-dev, eng-smoke-code-reviewer]`, 1
process vs 2, ~11% cheaper, file produced and reviewed.

Note: the dispatch tool is surfaced as **`Agent`** in CLI 2.1.x (older docs call
it `Task`); detectors must accept both names.

## Trade-offs (why opt-in, not the default)

| Capability | `process` (default) | `subagent` |
|---|---|---|
| Independent kill/restart/retry per worker | ✅ | ❌ (workers die with the lead) |
| Cross-session / daemon-persistent / swarm | ✅ | ❌ (local to one session) |
| Per-worker ticket claim/complete | ✅ | ❌ |
| Worktree isolation | ✅ | ❌ (refused — untracked recipes) |
| Process / cost overhead | N+1 processes | ✅ one process, shared context & auth |
| Setup simplicity | spawn protocol | ✅ write markdown |

## Consequences

- The `subagent-provisioner.ts` module is pure (fs + crypto only) and fully
  unit-tested; it is dormant unless a team runs under `subagent`.
- `team_status` for a subagent-mode team shows the lead plus the provisioned
  `subagentRoster`; per-role busy/idle tracking off the lead's `Task`
  tool_use→tool_result stream is a natural follow-on (the stream is already
  parsed in `lifecycle.ts`, which emits `agent:hook` PostToolUse per tool_use).
- Native chat already uses Claude Code's first-class `Agent`/`SendMessage`
  primitives directly, so this setting is most relevant to **daemon-driven
  team runs** that want the cheaper single-session shape.

## Verified by live A/B (2026-06-18, CLI 2.1.181, haiku)

Same task (`create calc.js add(a,b); have it reviewed`) run both ways:

| | subagent | process |
|---|---|---|
| processes | 1 | 2 |
| cost | $0.069 | $0.078 |
| dispatched | `eng-smoke-backend-dev`, `eng-smoke-code-reviewer` | n/a |
| file produced + reviewed | ✅ | ✅ |

Subagent mode is cheaper and uses one process; both produce correct, reviewed
output. The diagnostic (`scripts/diagnostics/run-subagent-vs-process.js`) is kept
as a manual, paid smoke test.

## Open follow-on: inline `--agents` to lift the worktree restriction

The live work also confirmed `claude --agents '<json>'` dispatches subagents
**inline** (no files on disk) — `{ "<name>": { description, prompt, tools?,
model? } }`. Because nothing is written to `.claude/agents/`, this sidesteps the
untracked-file / worktree-invisibility problem entirely. A future revision should
add an `inline` provisioning mode (build the JSON, pass `--agents` to the lead)
and drop the worktree refusal for that mode. Deferred — the file-based path is
shipped and verified; inline is an optimization, not a correctness fix.
