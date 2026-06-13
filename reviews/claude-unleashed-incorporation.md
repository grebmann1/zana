# What to incorporate from `claude-unleashed` into zana

**Method:** three parallel gap-analysis agents (`/zana:zana` fan-out) compared zana against the
`claude-unleashed` clone (`/tmp/cu-review`, HEAD `e08cab6`) across resilience, scheduler, and
agent-safety mechanisms. This is a *gap* analysis — "what logic should we port?" — not a quality
review. Every headline claim was spot-checked against source in **both** repos (see Verification).

**Framing that shaped every call.** zana is bimodal:
- **Native path** (in-session `Agent`+`SendMessage`): the host Claude Code process owns the
  subagents — zana has no event stream, no pids, no lifecycle hooks. Supervision here can only be
  *prompt-encoded*. CU's daemon machinery does **not** fit here.
- **Daemon path** (`packages/core/src/agents/lifecycle.ts` spawns `claude` subprocesses; `packages/work`
  scheduling/tickets/deliberation): zana owns the process, stream, and pid — structurally like CU.
  **This is where CU's logic actually ports.**

Two findings the analysis is emphatic about:
- **zana is *ahead* of CU on state-machine guards.** CU's worst incident (ADR 0027, ~$88 data-loss)
  came from raw status writes with no `canTransition()`. zana's tickets (`STATUS_TRANSITIONS`,
  `tickets/service.ts:8`) and deliberation (`TRANSITIONS` + OCC versioning, `deliberation/run.ts:134`)
  already have explicit, tested transition maps. **CU should port from zana here, not the reverse.**
- Several CU mechanisms (auth circuit breakers, single-flight token refresh, auto-unstick,
  approval timeouts) guard subsystems zana **doesn't run** or solve problems zana **doesn't have**.
  Those are explicitly *not* recommended below.

---

## Ranked recommendations

| # | Mechanism | zana gap (verified) | Fit | Effort | Verdict |
|---|---|---|---|---|---|
| 1 | **Schedule consecutive-failure breaker** | `triggerSchedule` records `lastRunResult`/`runCount` but never auto-disables; a schedule with a deleted `profileId` re-fires forever (`scheduling/service.ts:421-432`) | daemon | **S** | **Do** |
| 2 | **Scheduler overlap-skip (liveness-gated)** | `inflightAgents` is a 6-min time-based memory prune, **not a fire gate** — confirmed double-fire when an agent runs past TTL (`scheduling/service.ts:40-57`) | daemon | **M** | **Do** |
| 3 | **Wire or delete the dangling spawn breaker** | call sites exist (`lifecycle.ts:419,433`, `dispatch.ts:43`) but **no `resilience` module exists** → permanent no-op that *reads* as protection | daemon | **S** | **Do** |
| 4 | **Post-run anomaly detection** | `persistAgentRun` writes cost/turns/exit to `runs/<id>.json` but **nothing reads it back**; no anomaly/post-mortem (`lifecycle.ts:265`) | both | **M** | **Do** |
| 5 | **Backoff between guardrail/probe retries** | `guardrails/index.ts:89` retries with **zero delay**; probe classifies transient errors but never retries with patience | daemon | **S–M** | **Maybe** |
| 6 | **Progress/loop stall detection** | only wall-clock SIGTERM (`lifecycle.ts:402`); an agent re-running `npm build` against a held port burns 10 min unnoticed | daemon | **M** | **Maybe** |
| 7 | **Catch-up-on-boot for missed schedules** | node-cron/`setInterval` have no memory of missed slots — a nightly schedule down at 02:00 silently never runs (no storm, but no catch-up) | daemon + loop | **L** | **Maybe** |
| 8 | **Turn-cap auto-extension** | autopilot hard-stops at `maxIterations` (`modules/autopilot/index.js:43,109`); no progress-based extension | daemon | **M** | **Defer** |
| 9 | **Degraded-outcome detection** | success is exit-code-only; a "booted but every tool errored" run records `success` (`scheduling/service.ts:98`) | daemon | **M–L** | **Defer** (needs per-tool telemetry first) |
| — | Auth breakers / single-flight / auto-unstick / approval-timeout | guard subsystems zana doesn't run, or problems zana doesn't have | — | — | **Skip** |

---

## The "Do" tier (4 items, mostly small)

### 1. Schedule consecutive-failure circuit breaker — *S, do first*
A daemon schedule pointing at a deleted profile or a perma-failing skill calls `executeAction` →
`{status:"error"}` on **every** cron/interval tick, forever (`scheduling/service.ts:451-453`).
There is no counter and no auto-disable — only manual `disableSchedule` (`service.ts:246`).

**Port** CU's pattern (`schedules/executor.ts:119-127`, `store.ts:197-207`): a `consecutiveErrors`
field on the already-persisted `status` block, incremented on `actionResult.status === "error"`,
zeroed on success; at threshold 3 set `schedule.enabled = false` + an `autoDisabledReason` and call
`stopTrigger(id)`. The enable/disable surface already exists — this is a few fields plus a threshold
check inside `triggerSchedule`. CU scopes its breaker to *boot* errors (launch failed, not run
failed); for v1, scope zana's to **synchronous-launch errors** (profile/skill/team-not-found,
command spawn ENOENT) — that's the perpetually-misconfigured case that actually storms.
Targets: `scheduling/service.ts` (counter + check), `scheduling/schema.ts` (new status fields).

### 2. Scheduler overlap-skip, made liveness-based — *M*
**Confirmed bug:** zana's `inflightAgents` map (`service.ts:40`) is purely a memory-leak guard —
`sweepInflightAgents()` prunes entries older than 6 min but is **never consulted before firing**.
A `spawn-agent` schedule on `every: 5m` whose agent runs 12 min spawns a second and third agent on
top of the first. CU explicitly prevents this (`schedules/executor.ts:263-271`): if the prior
`last_session_id` is still `running`/`paused`, record `skipped("prev-run-still-active")`.

**Port:** gate the fire in `triggerSchedule` before `executeAction` — iterate the existing
inflight map (already keyed by agentId, valued `{scheduleId, spawnedAt}`), and if any entry for
this schedule maps to an agent whose `state` is `running`/`paused`, record a `skipped` result and
return. The change is from a *time-based prune* to a *liveness check* — the map already holds what's
needed. Add `"skipped"` to the `lastRunResult` vocabulary. Target: `scheduling/service.ts`.

### 3. Wire (or delete) the dangling agent-spawn breaker — *S*
**Confirmed:** `dispatch.ts:43-44` and `lifecycle.ts:419-434` call
`getModule("resilience")?.api?.isOpen/recordFailure/recordSuccess("agent-spawn")` — but **there is
no `resilience` module** (no `modules/resilience/` dir, no manifest; only these call sites). The
hooks always resolve to `undefined` → falsy → the breaker never trips. This is worse than absent:
it reads as protection in review but is a guaranteed no-op.

Two honest options:
- **(a) Implement it** — a ~40-line in-memory breaker keyed `"agent-spawn"` (consecutive-failure
  count, open for a cooldown after N, half-open probe), registered as a `resilience` module so the
  existing, correctly-placed call sites light up. Closes a real failure-amplification hole (a melted
  gateway → orchestrator keeps firing doomed spawns).
- **(b) Delete the dead hooks** if the heaviness isn't wanted.

Either is defensible; **(a)** is low-effort given the seams are already at the right boundaries.
Note: zana's existing `spawnOverloadStreaks` escalation (`lifecycle.ts:69-85`, `dispatch.ts:50-60`)
already handles load *refusals* — the breaker would specifically cover spawn *failures*
(auth/quota/transport), a different class. Target: new `packages/core/modules/resilience/`.

### 4. Post-run anomaly detection — *M, both paths, highest cross-cutting ROI*
zana **already persists the raw material**: `persistAgentRun` (`lifecycle.ts:265-295`) writes
`costUsd`, `numTurns`, `durationMs`, `exitCode`, `result` to `runs/<id>.json` — and nothing ever
reads it back. CU's `detectAnomalies` (`core/src/postmortem/detect.ts:17`) is a **pure function**
with three classes that map directly onto fields zana already has: `near-limit` (>80% of a limit),
`non-zero-exit`, and `repeated-tool-call`.

**Port:** add `packages/work/src/runs/anomaly.ts` (a pure `detectAnomalies(record, limits)`), call
it from the `child.on("close")` handler (`lifecycle.ts:423-437`) right after `persistAgentRun`, and
emit an `AGENT_ANOMALY` bus event. The `near-limit` + `non-zero-exit` checks need only fields already
on the record — so this **works on the daemon path immediately**, no new telemetry. Borrow CU's
`Limits`/`DEFAULT_LIMITS` shape (`core/src/limits/types.ts:3`) but down-tune (zana's 10-min cap vs
CU's 2-hour sessions). Skip CU's markdown post-mortem rendering initially — an event + a field on
the run JSON is enough. **Tenant-isolation invariant:** write any artifact through
`getProjectPaths().runsDir`, never `~/.zana/` (see ADR 0002).

---

## "Maybe" tier — worth it under conditions

- **#5 Retry backoff (S–M).** `guardrails/index.ts:89` retries up to 2× with zero delay; if the
  failure is a 429 the immediate re-spawn worsens it. zana already has the *classifier* half
  (`probe-agent.ts classifySpawnError` buckets rate_limit/quota/transport vs structural), so the
  missing piece is just a small delay schedule (`[1s,5s,15s]`) + short-circuiting structural
  failures that won't self-heal. Most valuable on the probe path (a deliberation probes N voters × 3
  legs). Port the shape of CU `runtime/api-error-retry-policy.ts:34-77`.
- **#6 Loop/stall detection (M, daemon-only).** zana already parses stream-json in
  `lifecycle.ts:353-391` but discards `tool_use` blocks. Feed them into a rolling counter keyed
  `${name}:${JSON.stringify(input)}` (CU's exact key, `detect.ts:130`); at 3 identical, emit a stall
  event / early SIGTERM. Port the generic `repeated-tool-call` counter, **not** CU's
  `build-loop-detector.ts` wholesale (its signal strings + pid-matching are tuned to CU's
  orphan-background-process problem). Native path stays prompt-only.
- **#7 Catch-up-on-boot (L, gate it).** zana under-fires (never storms): a daemon down through a
  cron slot silently skips it; the daemon-free `/loop` path is even more exposed (a shell sleeper
  with no persistence). zana already writes `status.nextRunAt` (`service.ts:468`); on `loadFromDisk`,
  if a stored `nextRunAt` is in the past, fire once before `startTrigger`. **Make it opt-in**
  (`catchUpOnBoot: true`) — silently firing a missed destructive `command` on every restart is a
  footgun.

## "Defer" / "Skip"

- **#8 Turn-cap auto-extension — defer.** For native autopilot it's actively wrong (host LLM
  grading its own subagents mid-loop = the unbounded spend the `maxIterations:5` + user-confirmation
  fence exists to prevent). A narrow daemon-autopilot version (one bounded extension when the last
  evaluator verdict showed movement) is plausible but should wait until #4 yields anomaly data
  showing iterations are actually orphaned mid-progress.
- **#9 Degraded-outcome detection — defer.** Real blind spot (exit-0-but-every-tool-errored records
  `success`), but needs zana to capture per-tool-call error flags first — verify what
  `runs/<id>.json` contains before committing; likely L, not M.
- **Skip:** auth circuit breakers (no long-lived gRPC/Slack pollers in zana), single-flight token
  refresh (no shared refreshable resource), auto-unstick + ToolProcessTracker (heavy ps-sampling for
  CU's persistent-worker model; zana's `zombie-reaper.ts` already handles orphans, and agents are
  short-lived), approval timeouts (zana's gates are non-blocking by design — `recordOverride` never
  awaits, ticket-review hard-caps at 3 strikes).
- **Dedup-on-create:** CU dedups because Salesforce Pub/Sub *redelivers*; zana tickets are created
  by humans/agents in-session, not a redelivering bus — only worth it if a daemon schedule
  auto-files tickets.

---

## Two zana-internal fixes this surfaced (not CU ports)

The analysis incidentally found two issues that are zana's own, worth folding in:

1. **`completeTicket` bypasses `STATUS_TRANSITIONS`.** `completeTicket` (`tickets/service.ts:143-158`)
   and the `ticket_update` fast-path (`dispatch.ts`) set `status = "done"` with a bare assignment,
   skipping the transition guard that `updateStatus` enforces — so a `backlog`/`blocked` ticket can
   jump straight to `done` without passing `review`. **This is exactly the gap the new
   `/zana:ticket:review` gate is meant to close**, and tightening `completeTicket` to route through
   the guard (or at least reject illegal source states) complements that work.
2. **Agent lifecycle `state` mutates with bare assignments** (`spawning`/`active`/`idle`/…) with no
   transition map — but it's an in-memory ephemeral process-mirror, not durable state, so a guard
   there would be gold-plating. Noted, not recommended.

---

## Suggested sequencing

**Quick wins first** (all S, daemon-path, independently shippable): #1 schedule breaker → #3 wire/delete
the spawn breaker → then #2 overlap-skip (M, same file). These three are concentrated in
`scheduling/service.ts` + `agents/{lifecycle,dispatch}.ts` and each is testable in isolation.
Then **#4 anomaly detection** as the one cross-cutting feature add. Treat the `completeTicket` guard
fix as part of the ticket-review work already in flight. Hold the "Maybe"/"Defer" tier until these
land and prove out.

---

## Verification (provenance spot-checks, both repos)

- Dangling resilience breaker: call sites at `lifecycle.ts:419,433` + `dispatch.ts:43`; **no**
  `modules/resilience/` dir or manifest → confirmed no-op.
- Scheduler no auto-disable: `service.ts:421-422` writes `lastRunResult`/`runCount`; only manual
  `disableSchedule` at `:246`; no consecutive-error counter → confirmed.
- Overlap is a time prune not a fire gate: `service.ts:40-57` `sweepInflightAgents` (TTL-only),
  never called before `executeAction` → confirmed double-fire.
- `completeTicket` bypass: `service.ts:143-158` sets `status="done"` directly, no
  `STATUS_TRANSITIONS` check → confirmed.
- zana ahead on guards: `STATUS_TRANSITIONS` (`tickets/service.ts:8`), deliberation `TRANSITIONS` +
  version (`deliberation/run.ts:134`) → confirmed.
- CU sources cited (overlap `executor.ts:263-271`, breaker `executor.ts:119-127`/`store.ts:197-207`,
  `detectAnomalies` `postmortem/detect.ts`, `turn-extension-decider.ts`, `auto-unstick.ts`) read
  during analysis at `/tmp/cu-review/` (clone since removed).
