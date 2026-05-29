# Zana recipes — end-to-end examples

Concrete, end-to-end examples for the most common Zana primitives. Every recipe
on this page is mirrored by a live integration test under `scripts/qa/` —
each script spawns real Claude Code workers and asserts the full lifecycle.

If a recipe drifts from reality, the QA script will fail. So when in doubt,
read the script for the literal, working sequence.

| Primitive | Recipe below | Live QA script |
|---|---|---|
| Schedule + spawn-agent action | [Recurring agent on a schedule](#recurring-agent-on-a-schedule) | `scripts/qa/run-scheduler-agent-live.sh` |
| Tickets | [Ticket-driven worker](#ticket-driven-worker) | `scripts/qa/run-ticket-live.sh` |
| Autopilot | [Goal-driven autopilot](#goal-driven-autopilot) | `scripts/qa/run-autopilot-live.sh` |
| Runtime / oneshot | [One-shot query and deliberation](#one-shot-query-and-deliberation) | `scripts/qa/run-runtime.sh` |

The remainder of this file covers primitives that aren't yet in the live QA suite:

- [Teams (orchestrator + workers)](#teams-orchestrator--workers)
- [Sprints (group tickets, track a board)](#sprints)
- [Schedule action types beyond `spawn-agent`](#schedule-action-types)
- [Workflows (multi-step skills)](#workflows)
- [Inter-agent messaging](#inter-agent-messaging)
- [Vector memory](#vector-memory)
- [Pub/sub channels and the event bus](#channels-and-events)
- [Profiles and skills](#profiles-and-skills)
- [Module config (autopilot, deliberation)](#module-config)
- [Checkpoints](#checkpoints)
- [Multi-daemon swarm](#multi-daemon-swarm)
- [Validated spawn (output guardrails)](#validated-spawn)
- [Artifacts (shared planning docs)](#artifacts)

> **Cross-reference.** Field names, enums, and return shapes are documented in
> [`MCP-TOOL-REFERENCE.md`](MCP-TOOL-REFERENCE.md). Use that file as the
> source of truth for any tool argument; this file is for shape, not signature.

---

## Recurring agent on a schedule

A YAML file in `.zana/scheduler/` becomes a portable schedule. The same file
can be driven by the daemon (heavy, persistent, full history) or by Claude
Code's `/loop` (lightweight, in-session, no daemon).

**1. Author the schedule.**

```yaml
# .zana/scheduler/qa-spawn.yml
id: qa-spawn
name: QA spawn-agent schedule
description: Fires a researcher agent every 24h.
enabled: true
schedule:
  every: 24h        # also: 30s, 5m, 1h, 2d — or `cron: "0 2 * * *"`
action:
  type: spawn-agent
  profileId: researcher
  prompt: "Reply with the single word: PONG"
history:
  enabled: true
  retain: 5
```

**2. Reload the daemon's view of disk.**

In Claude Code:

```
/zana:schedule:reload
/zana:schedule:list           # qa-spawn should appear
```

Or via CLI:

```bash
zana schedule reload
zana schedule list --workspace /path/to/ws
```

**3. Trigger a run on demand.**

The MCP tool returns immediately on spawn — the agent runs detached on the
daemon. Poll `schedule history` until the entry leaves `pending`.

```jsonc
// MCP — from a Claude Code conversation
zana_schedule_trigger({ scheduleId: "qa-spawn" })
// → { ok: true, schedule: {...}, result: { status: "success", agentId, finalStatus: "pending", ... } }
```

```bash
# CLI mirror
zana schedule trigger qa-spawn --workspace /path/to/ws
zana schedule history qa-spawn -n 1 --workspace /path/to/ws
# → 2026-05-29T08:38:47.402Z | success | PONG
```

**4. Confirm the spawned agent ran to completion.**

```jsonc
zana_list_agents({})
// look for { profileId: "researcher", state: "terminated", result: "PONG..." }

zana_agent_result({ agentId: "<id>" })
// → { completed: true, state: "terminated", result: "PONG", id: "<id>" }
```

The QA script polls these every second for up to two minutes, which is enough
to cover real-Claude latency:

```
T1 PASS  qa-spawn schedule registered
T2 PASS  trigger fired spawn-agent — history success | … | PONG
T3 PASS  spawned agent terminated with PONG
T4 PASS  history retained 2 entries after re-trigger
```

> **Note.** If you're using `/loop` instead of the daemon, the same yml file
> works — `cron:` schedules are daemon-only and `/loop` will refuse them and
> point you to the daemon path.

---

## Ticket-driven worker

The orthodox flow: create a ticket → claim it → spawn a worker that does the
work → mark complete. Every transition is auditable on the ticket record.

**1. Create the ticket.**

```jsonc
zana_ticket_create({
  title: "QA-live: confirm PONG",
  description: "Reply with PONG to confirm.",
  priority: "low"
})
// → { id: "<ticketId>", status: "backlog", priority: "low", … }
```

**Watch out:** priority enum is `critical|high|medium|low`, NOT `P0/P1/...`.
Initial status is always `backlog` — there's no `open`.

**2. Claim it.**

```jsonc
zana_ticket_claim({ ticketId, agentId: "<your-id>", agentName: "QA Live" })
// → { ok: true, status: "in_progress" }
```

**3. Spawn a worker.**

```jsonc
zana_spawn_agent({
  profileId: "researcher",
  prompt: "Reply with the single word: PONG"
})
// → { agentId, status: "spawned" }
```

Poll `zana_agent_status` (or `zana_list_agents`) until `state === "terminated"`,
then read the result with `zana_agent_result`. Real-Claude workers can take
30–120s for a tiny prompt — budget accordingly.

**4. Complete the ticket.**

```jsonc
zana_ticket_complete({
  ticketId,
  resultSummary: "Worker confirmed: PONG",
  completedBy: "qa-live"
})
// → { ok: true, status: "done" }

zana_ticket_get({ ticketId })
// → { …, status: "done", resultSummary: "…" }
```

**Live test result (`scripts/qa/run-ticket-live.sh`):**

```
T0 PASS  daemon up on port 47413
T1 PASS  ticket created id=…
T2 PASS  ticket present in /tickets list
T3 PASS  ticket claimed by qa-live
T4 PASS  researcher worker terminated with PONG
T5 PASS  ticket completed
T6 PASS  ticket status now 'done'
```

---

## Goal-driven autopilot

Autopilot loops a sequence of agent steps until success criteria are met. Each
iteration runs every step, then an evaluator agent judges the criteria and
either settles the goal or kicks off another iteration (up to `maxIterations`,
default 5).

**1. Submit the goal.**

```jsonc
zana_autopilot_goal_driven({
  title: "QA-live autopilot smoke",
  criteria: "Each step produced a non-empty answer.",
  steps: [
    { profile: "researcher", prompt: "Reply with: STEP1-OK" },
    { profile: "researcher", prompt: "Reply with: STEP2-OK" }
  ]
})
// → { goalId: "<uuid>", status: "running" }
```

The call returns immediately. The loop runs detached on the daemon.

**2. Poll status.**

```jsonc
zana_autopilot_goal_status({ goalId })
// → {
//   id, title, status: "running" | "completed" | "failed" | "exhausted" | "cancelled",
//   iteration: 1,
//   results: [ { step, agentId, summary }, … ],
//   lastEvaluation: "VERDICT: PASS" | "VERDICT: FAIL\nReason: …"
// }
```

`iteration >= 1` proves the spawn loop fired (each iteration runs all steps
plus the evaluator). The QA script polls for up to 90s waiting for that
signal.

**3. Cancel if needed.**

```jsonc
zana_autopilot_goal_cancel({ goalId })
// → { ok: true }
```

After cancel, the next `zana_autopilot_goal_status` returns
`status: "cancelled"`.

**Live test result (`scripts/qa/run-autopilot-live.sh`):**

```
T0 PASS  daemon up on port 47414
T1 PASS  goal created id=…
T2 PASS  goal in list
T3 PASS  goal advanced (iter=1 status=running)
T4 PASS  goal cancelled
T5 PASS  goal terminal status=cancelled
```

> **Known gotcha.** The HTTP `POST /api/autopilot/goals` route does not
> currently `await` `setGoal()`, so the response body serializes as `{}`.
> The MCP tool path returns the proper `{ goalId, status }` shape — but if
> you're hitting the REST API directly, list goals afterwards and pick the
> newest. The QA script uses that workaround. See
> `packages/server/src/api/server.ts:884`.

---

## One-shot query and deliberation

For small, throwaway questions you don't need a full agent session. For
high-stakes decisions you want multiple voices on the record.

### One-shot

```jsonc
zana_oneshot_query({
  profileId: "researcher",
  prompt: "Reply with the single word: PONG",
  timeout: 90000
})
// → text response (string)
```

Programmatic equivalent (this is what `run-runtime.sh` R1 actually runs):

```js
const core = require("@zana/core");
core.project.workspaceContext.init(REPO);
const profile = core.agents.profileStore.getProfile("researcher");
const { spawnOneShot } = require("@zana/core/dist/src/agents/spawner");

const r = await spawnOneShot(profile, "Reply with the single word: PONG", {
  cwd: REPO,
  timeout: 90000
});
// r.output → "PONG"
// r.exitCode → 0
```

### Deliberation

Multiple voters review a question in parallel; dissent is preserved verbatim;
the council either settles on a verdict or escalates. Returns immediately —
poll for the terminal state.

```jsonc
zana_deliberate({
  question: "Should we drop Node 18 support in v2.0?",
  voters: ["architect", "security-reviewer", "researcher"],
  rounds: 3,
  riskTag: "high"
})
// → { id, state: "PROPOSED", _outcome: "running", … }

// Later:
zana_deliberation_status({ deliberationId: id })
// → { state: "SETTLED" | "ESCALATED", _outcome, verdict, voters: [...] }
```

**Cheap proof the real path works (one voter, one round, ~45s):**

```bash
ZANA_RUNTIME=spawn node scripts/diagnostics/run-real-deliberation-snap.js
# [done] 45.0s — state=ESCALATED verdict=—
#
# vote: r1 architect CHANGES
#   raw output? VOTER PRODUCED IT (good)
#   tool calls: 1  (budget: ≤5)
```

A snap of `1 voter / 1 round / cap` legitimately escalates — the
unanimity-within-latest-round rule treats one CHANGES vote as no consensus.
That's the contract, not a bug.

**Live test result (`scripts/qa/run-runtime.sh`):**

```
R1 PASS  claude-spawn oneshot returned PONG (R1_OUTPUT: {"output":"PONG","exitCode":0})
R2 PASS  deliberation snap: real Claude voter ran ([done] 333.1s — state=ESCALATED verdict=—)
```

---

## Running the live tests yourself

These four scripts exist precisely so you can verify the recipes above on your
own machine. They cost real Claude tokens — none of the workers are mocked.

```bash
# Preconditions: `claude` CLI on PATH and logged in, repo built.
npm run build

# Run individual suites
bash scripts/qa/run-runtime.sh                  # ~6 min — oneshot + deliberation
bash scripts/qa/run-scheduler-agent-live.sh     # ~2 min — schedule fires real worker
bash scripts/qa/run-ticket-live.sh              # ~2 min — ticket lifecycle
bash scripts/qa/run-autopilot-live.sh           # ~2 min — goal-driven loop

# Or the orchestrator (kills stale daemons between suites)
bash scripts/qa/run-live-all.sh
```

Each suite uses a hermetic temp workspace under `/tmp/zana-qa-…/` and an
isolated daemon registry. They clean up after themselves.

If `claude` is not on PATH, every suite SKIPs gracefully — no false positives.

---

## Teams (orchestrator + workers)

A team is a configurable bundle: one orchestrator profile plus N worker
profiles. Starting a team spawns the whole formation in one call. Useful when
you want a recurring setup (e.g. "research → architect → coder → tester")
behind a single command.

```jsonc
zana_list_teams({})
// → [ { id, name, orchestratorProfileId, workerSlots: [{ profileId, count }, ...] }, ... ]

zana_get_team({ teamId })
// → full team config

zana_start_team({
  teamId: "code-review-pipeline",
  prompt: "Review packages/work/src/scheduling for race conditions.",
  cwd: "/abs/path/to/repo"
})
// → { runId, orchestratorAgentId, workerAgentIds: [...] }

zana_team_status({ teamId })
// → { runId, orchestrator: { id, state }, workers: [{ id, profileId, state }, ...] }

zana_list_running_teams({})
// → all currently-active team runs

zana_stop_team({ teamId })
// → terminates the orchestrator and every worker
```

> **Custom teams.** Drop a JSON file under `~/.zana/teams/` (or your
> workspace's team dir) following the schema returned by `zana_list_teams`.
> The MCP server reloads on next call.

---

## Sprints

Sprints group tickets and provide a kanban-style board. The lifecycle is:
create → add tickets → start → end. The board view is the read model.

```jsonc
zana_sprint_create({
  name: "Q3-W2: scheduler hardening",
  ticketIds: [t1, t2, t3]   // optional — can add later
})
// → { id, name, status: "planning", tickets: [...] }

zana_ticket_add_to_sprint({ ticketId, sprintId })

zana_sprint_start({ sprintId })
// → { ok: true, status: "active", startedAt }

zana_sprint_board({ sprintId })
// → {
//   backlog:    [...tickets with status==='backlog'],
//   inProgress: [...],
//   review:     [...],
//   done:       [...]
// }

zana_sprint_list({ status: "active" })   // optional filter
zana_sprint_end({ sprintId })            // → status: "completed", endedAt
```

`zana_sprint_board` is the only "wide" read — every other call returns a
single sprint or a flat list.

---

## Schedule action types

The recipe at the top of this file uses `type: spawn-agent`. Three more
action types exist; all four go through the same scheduling pipeline.

### `command` — exec a binary

```yaml
# .zana/scheduler/nightly-build.yml
id: nightly-build
name: Nightly build
enabled: true
schedule:
  cron: "0 2 * * *"            # 02:00 daily — daemon-only
action:
  type: command
  command: ["npm", "run", "build"]   # ARRAY only; shell strings rejected
  cwd: .                              # default = workspace root
history:
  enabled: true
  retain: 14
```

The runner is `execFile` — no shell interpretation. If you need pipes or
redirects, wrap explicitly: `["sh", "-c", "cmd | other"]`.

### `workflow` — run a registered workflow skill

```yaml
action:
  type: workflow
  skillId: triage-stale-tickets    # must resolve to a skill of type=workflow
```

The result includes `runId`, queryable via:

```jsonc
zana_workflow_list_runs({})              // recent runs
zana_workflow_get_run({ runId })         // full run record (steps, status, output)
```

### `mcp_tool` — call any Zana MCP tool on a cadence

```yaml
action:
  type: mcp_tool
  toolName: zana_ticket_list           # must start with "zana_"
  toolArgs:
    status: in_progress
```

Useful for: scheduled audits, periodic reports, cron-driven checkpointing.
The result lands under `result.data`.

> **`/loop` compatibility:** `command` and `spawn-agent` translate to
> `/loop` cleanly. `workflow` and `mcp_tool` are daemon-only. `cron:` is
> daemon-only regardless of action type — `/zana:loop:start` will refuse it
> and point you at the daemon path.

---

## Workflows

Workflows are multi-step skills — a YAML/JSON skill file declares an
ordered list of MCP tool calls with templated arguments. Run one ad-hoc with
`zana_workflow_run` or schedule it with `type: workflow`.

```jsonc
zana_workflow_run({ skillId: "triage-stale-tickets", input: { dayThreshold: 14 } })
// → { runId, status: "running" }

zana_workflow_list_runs({})
// → [ { runId, skillId, status, startedAt, finishedAt }, ... ]

zana_workflow_get_run({ runId })
// → {
//   id, skillId, status: "completed" | "failed" | "running",
//   steps: [ { name, toolName, toolArgs, result, status }, ... ],
//   startedAt, finishedAt, error?
// }
```

Workflow skills live alongside agent skills in the skill store
(see [Profiles and skills](#profiles-and-skills)).

---

## Inter-agent messaging

Named agents talk directly via `SendMessage` — no polling, no shared state.
This is the same primitive Claude Code's own `Agent` tool surfaces; from a
Zana orchestrator (or another agent), you reach it via MCP.

```jsonc
zana_send_message({
  toAgentId: "<target-agent-id>",
  type: "handoff",                        // question | finding | handoff | status | request
  payload: {
    kind: "ticket",
    ticketId,
    content: "Coder finished — please review.",
    paths: ["packages/work/src/scheduling/service.ts"]
  },
  priority: "normal",                     // low | normal | urgent
  requiresAck: true                       // optional — ack lands later
})
// → { ok: true, delivered: "local" | "remote" | "failed", messageId }

zana_check_inbox({ agentId })
// → [ { messageId, from, type, payload, sentAt, ackRequired }, ... ]

zana_send_ack({ messageId, status: "completed", response: "Review done — LGTM" })
// → ok

// Synchronous ask/answer (rarely needed):
zana_ask_agent({ targetAgentId, question, timeoutMs: 60000 })
// → string answer
```

**Pitfall.** Three delivery branches: local (in-daemon), remote (sub-daemon
via swarm router), or failed. Always check `delivered` before assuming the
target received the message. If `requiresAck`, the ack arrives via
`zana_send_ack` later — the send response itself does not wait.

---

## Vector memory

HNSW-backed pattern memory. Store what worked at the end of a successful run;
search before starting a new task to surface prior solutions.

```jsonc
zana_memory_store({
  content: "Race condition in scheduler.executeAction was caused by two triggers landing within 50ms — fixed with sweepInflightAgents() + per-agent termination listener.",
  tags: ["scheduling", "race-condition", "bugfix"],
  metadata: { ticketId, commitSha: "abc1234" }
})
// → { id, embeddingId }

zana_memory_search({
  query: "scheduler race condition",
  k: 5,                                  // top-k results
  tags: ["scheduling"]                   // optional filter
})
// → [ { id, content, score, tags, metadata }, ... ]
```

Embeddings are computed locally via the configured embedder; no external
service required. Memory is per-workspace by default; daemon config controls
whether it spans workspaces.

---

## Channels and events

Two pub/sub layers ship side-by-side:

- **Channels** — opt-in topics agents subscribe to. Useful for
  "watch every ticket transition", "notify on every deliberation outcome".
- **Event bus** — every spawn, message, ticket transition, and verdict is
  emitted as a structured event. Replayable from disk.

```jsonc
zana_publish_channel({
  channel: "code-review",
  payload: { ticketId, decision: "approve", reviewer: agentId }
})

zana_subscribe_channel({ agentId, channel: "code-review" })
zana_list_channels({})
zana_channel_history({ channel: "code-review", limit: 50 })

// Event bus
zana_event_emit({ type: "custom:my-event", data: { ... } })
zana_event_query({ types: ["agent:spawned", "ticket:completed"], since: "2026-05-29T00:00:00Z", limit: 100 })
```

Event log rotation is size-based: `ZANA_EVENT_LOG_MAX_BYTES` (default
~50 MB) — older segments are gzipped.

---

## Profiles and skills

Profiles define agent identity; skills are reusable instruction modules
(plus optional MCP tool hooks) that any agent can pull in. Both are
CRUD-able through MCP.

```jsonc
// Profiles
zana_list_profiles({})
zana_get_profile({ profileId })
zana_save_profile({
  id: "security-auditor",
  name: "Security Auditor",
  systemPrompt: "...",
  allowedTools: ["Read", "Grep", "WebFetch"],
  inheritsFrom: "researcher"             // optional
})
zana_delete_profile({ profileId })

// Skills
zana_list_skills({})
zana_get_skill({ skillId })
zana_save_skill({
  id: "owasp-top-10",
  type: "instruction",                   // instruction | workflow
  body: "...markdown content..."
})
zana_toggle_skill({ skillId, enabled: false })
zana_delete_skill({ skillId })
```

Profiles and skills live in the workspace store (`.zana/profiles/`,
`.zana/skills/`) with global fallbacks under `~/.zana/`.

---

## Module config

Autopilot, deliberation, and example are first-class **modules** with
config schemas. Inspect or tune them at runtime through MCP — no daemon
restart needed.

```jsonc
zana_module_config_list({})
// → [
//   { moduleId: "autopilot",    schema: { maxIterations: { type: "number", default: 5, ... }, ... }, current: {...} },
//   { moduleId: "deliberation", schema: { ... }, current: {...} }
// ]

zana_module_config_get({ moduleId: "deliberation" })
// → { defaultRounds: 2, defaultQuorum: "majority", voterTimeoutMs: 1200000, ... }

zana_module_config_set({
  moduleId: "deliberation",
  config: { defaultRounds: 3, voterTimeoutMs: 1800000 }   // partial update
})
// → { ok: true, current: {...merged config} }
```

**Knobs worth knowing.** Deliberation: `voterTimeoutMs` (default 20 min —
real-Claude voters reading a codebase can hit this), `synthesisSimilarity`
threshold for cross-voter finding grouping, `probeCacheTtlMs`. Autopilot:
`maxIterations` (default 5) and `evaluatorProfile` (default
`code-reviewer`).

---

## Checkpoints

Checkpoint = a named, resumable point inside a long-running run.
Deliberations and autopilot use them internally; you can also create custom
checkpoints from your own workflows.

```jsonc
zana_checkpoint_save({
  runId,
  name: "after-research",
  state: { foundFiles: [...], ranked: true }
})
// → { id, runId, name, savedAt }

zana_checkpoint_list({ runId })
zana_checkpoint_get({ checkpointId })
zana_checkpoint_resume({ checkpointId })
// → re-hydrates the run from the saved state and returns control
```

Tenant-isolated. Deliberation checkpoints (`kind: "deliberation"`) MUST
land under `<workspace>/.zana/checkpoints/` and refuse to fall back to
`~/.zana/` — that fallback is a global pool shared across every workspace
on the host.

---

## Multi-daemon swarm

For very large efforts, spawn child daemons. Each child runs its own
orchestrator + worker formation; the parent routes events and broadcasts.

```jsonc
zana_swarm_spawn({
  teamId: "feature-pipeline",
  prompt: "Implement v2 auth — design, code, test, review, document.",
  cwd: "/abs/path/to/repo"
})
// → { daemonId, port, pid }

zana_swarm_list({})
// → [ { daemonId, port, status, runId, ... }, ... ]

zana_swarm_instruct({ daemonId, message: "Pause coder workers — reviewer found a regression." })
zana_swarm_broadcast({ message: "Freeze all merges until 18:00 UTC." })

zana_swarm_poll_events({ since: "2026-05-29T00:00:00Z", limit: 200 })
// → cross-daemon event stream

zana_swarm_stop({ daemonId })
// → terminates the child daemon and all its workers
```

The default daemon listens on port 47402; child daemons get
auto-incremented ports. Each maintains its own registry under
`~/.zana/daemons/<id>.json`.

---

## Validated spawn

When the worker's output must satisfy hard constraints (must contain a
substring, must parse as JSON, must match a schema, etc.), use the
guardrailed spawn variant. On validation failure the worker is retried with
feedback up to `maxRetries` times.

```jsonc
zana_spawn_agent_validated({
  profileId: "test-writer",
  prompt: "Write a vitest test that asserts spawnOneShot returns PONG.",
  guardrails: [
    { type: "must_contain",     value: "spawnOneShot" },
    { type: "must_match_regex", value: "expect\\([^)]+\\)\\.toBe\\(" },
    { type: "max_lines",        value: 200 }
  ],
  maxRetries: 2                          // default 2
})
// → { agentId, status: "spawned", guardrailsApplied: 3 }
```

Each retry receives the validation feedback as additional prompt context, so
the worker can correct course rather than repeat the same mistake.

---

## Artifacts

Shared planning docs that survive across agents and runs. Useful for
architecture decisions, requirement specs, and design notes that multiple
workers need to read or update.

```jsonc
zana_artifact_create({
  title: "v2 auth architecture",
  type: "architecture-doc",              // architecture-doc | requirement-spec | design-doc
  content: "## Goal\n..."
})
// → { id, title, type, version: 1, createdAt }

zana_artifact_list({ type: "architecture-doc" })
zana_artifact_read({ artifactId })
// → full record incl. version history

zana_artifact_update({
  artifactId,
  content: "## Goal\n... (revised after security review)\n..."
})
// → { id, version: 2, updatedAt }
```

Artifacts are versioned monotonically; every update bumps `version` and
appends to the audit trail. The orchestrator profile typically writes
artifacts and points workers at them via prompt context.

---

## What's not covered yet

These exist but don't have a dedicated recipe — read
[`MCP-TOOL-REFERENCE.md`](MCP-TOOL-REFERENCE.md):

- `zana_route_task` — task router (intelligence package): pick the best
  profile for a free-form description.
- `zana_plan_create` — GOAP-style planner that emits a sequenced step list.
- `zana_discover_agents` — list agents across all daemons in the swarm.
- `zana_workers_list` — background workers (audit, optimize, testgaps,
  map, document) dispatched by hook triggers.
- `zana_deliberation_override` — write-an-override on a settled
  deliberation. Human-in-the-loop is a feature, not a fallback.

If you want a recipe for one of these, open an issue — preferably with the
literal input/output shape you'd find useful.
