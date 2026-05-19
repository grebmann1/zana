# Orchestration

Orchestrate multi-agent workflows in Zana. You — the orchestrator — plan, delegate, and monitor. Workers do the implementation.

## When to spawn one agent vs a team

Spawn a **single agent** when the task is well-scoped to a few files and one specialty (one bug fix, one component, one doc page). Use `zana_spawn_agent` with the right profile and a tight prompt.

Spawn a **team** when the task crosses concerns or benefits from parallelism: planning + implementation + tests, or three independent features that can ship in parallel. Compose a team via multiple `zana_spawn_agent` calls — one per role (e.g. an architect, two coders, a tester).

Spawn a **child daemon swarm** (`zana_swarm_spawn`) only when each workstream is large enough to warrant its own orchestrator and workers — typically multi-day efforts or independent epics. In-process agents are cheaper for everything else.

## Breaking a task into tickets

Before spawning anyone, decompose. A useful ticket is:

- Independent (can be assigned to one worker without blocking others)
- Small (fits inside one agent's context plus a margin for tools and tests)
- Verifiable (has an acceptance criterion you can check from outside)

Use `zana_ticket_create` for each piece, then `zana_sprint_create` to group them and `zana_sprint_start` to begin. Tickets are not bureaucracy — they are the unit of dispatch and the thing you mark `complete` so the orchestration loop stays honest about progress.

## The execution path

You drive every step. The orchestrator plans, dispatches, and verifies — Zana does not guess about success on your behalf.

1. `zana_list_profiles` to see who is available.
2. `zana_spawn_agent` per ticket. Spawn independent tickets in parallel up to the concurrency cap (default 10).
3. `zana_list_agents` periodically to monitor.
4. `zana_agent_result` once an agent terminates — verify the work is real.
5. `zana_ticket_complete` with a result summary.

## Writing prompts that actually work

The single biggest cause of bad agent output is a thin prompt. Always include:

1. The task in one sentence.
2. The acceptance criterion ("done means tests pass and `foo()` returns X").
3. The relevant file paths — absolute or workspace-relative.
4. Conventions to match (test framework, error handling style, naming).
5. What is *out of scope* (so the agent doesn't refactor the world).
6. The expected output format (file changes? a report? a JSON blob?).

Bad: "Add user authentication."

Good: "Add password authentication to packages/server/src/auth/. Use bcrypt 5+, store hashes in the existing users table (see packages/server/src/db/users.ts), and expose POST /auth/login returning a JWT signed with `process.env.JWT_SECRET`. Tests live in tests/auth/ and follow the existing vitest pattern in tests/auth/oauth.test.ts. Do not modify the OAuth flow. Done = both new tests pass and `npm test` is green."

## Monitoring and result collection

`zana_list_agents` returns lightweight status. `zana_agent_status(agentId)` gives detail. `zana_agent_result(agentId)` returns the agent's final message and any structured output once `state === "terminated"`.

Two patterns:

- **Fan-out, gather**: spawn N independent agents, poll until all are terminated, then collect results in order. Good for parallel research.
- **Pipeline**: spawn agent A, wait for its result, feed it into agent B's prompt. Good when later steps depend on earlier outputs.

If an agent stalls, kill it (`zana_kill_agent`) and respawn with a sharper prompt. Don't pile on retries with the same prompt — it failed for a reason.

## Deliberation

Deliberation is a first-class primitive — sibling to `Team` and `Autopilot` — for bounded multi-perspective review with a verdict and an audit trail. Use it when a decision is consequential enough to deserve more than one voice, but not so open-ended that it needs a long-lived team.

### When to use Deliberation vs Team vs Autopilot

| Primitive | Shape | Use when |
|---|---|---|
| **Team** | Long-lived roster + topology, ongoing coordination | Multi-task work crossing roles (architect + coders + tester) over hours/days |
| **Autopilot** | Goal-driven loop, one evaluator | Iterate-until-done with a single judge — "keep trying until tests pass" |
| **Deliberation** | One-shot N voters + synthesis + ≤N convergence rounds (default 2) + verdict | A single decision needs multi-perspective review with dissent preserved and an auditable verdict |

If you only need one opinion, spawn one agent. If you need three perspectives on whether to ship, deliberate.

### Anatomy of a deliberation

State machine: `PROPOSED → REVIEWING → SYNTHESIZING → CONVERGING → SETTLED | ESCALATED | EXHAUSTED`.

- **PROPOSED**: question + voter set is locked in. Each voter carries a profile + lens.
- **REVIEWING**: voters spawn in parallel and each independently emits an APPROVE/CHANGES *stance* with an argued rationale. Every stance lands on the event bus content-addressed (`rationaleHash`, `promptSnapshotHash`) before any state mutation — this is the audit substrate. (We say "vote" colloquially, but the stance is shorthand for an argued position; the synthesis is what produces the verdict, not a tally.)
- **SYNTHESIZING**: findings are grouped by similarity into consensus / unique / disagreement. "minority report MUST be preserved, never collapsed" — dissent is kept verbatim.
- **CONVERGING**: up to N rounds (default 2) for voters to react to the synthesis. Hitting the cap without convergence routes to `EXHAUSTED → ESCALATED`.
- **SETTLED**: quorum reached, no unresolved dissent, no high-risk preempt.
- **ESCALATED**: dissent, cap hit, smoke probe skipped, or `riskTag: "high"` was set on entry. Human required.

### Override / dissent UX

A `SETTLED` verdict is a *proposed* state transition, not the transition itself. The runtime auto-routes to `pending_human` when **any** of:

- dissent exists in the synthesis report
- the round cap was hit
- the capability smoke probe was skipped for any voter
- the input carried `riskTag: "high"`

A human override is a typed `deliberation:override` event — symmetric with a voter's stance, identically auditable. Counter-intuitively, **unanimity makes override *easier*, not harder**: full agreement is a correlated-bias signal, not a strong signal.

### How to invoke

From a Claude Code chat:

```
> /zana:council should we drop Node 18 in v3?
```

(See `plugins/zana/core/commands/council.md` for the slash sugar; full design lives in artifact `f4de8302-4a88-496c-be40-d67a6e765794` — `~/.zana/artifacts/`.)

From an MCP-aware caller:

```
zana_deliberate({
  question: "should we drop Node 18 in v3?",
  voters: ["architect", "security-reviewer", "performance-engineer"],   // string profileIds — supported today
  // voters: [{lens: "architecture"}, {lens: "security"}, {lens: "performance"}],   // ← lens form lands when FU-T11-c wires resolveVoters into zana_deliberate
  rounds: 2,
  quorum: "majority",
  mode: "synthesis",
  riskTag: "medium",
  context: { artifactIds: ["..."] }
})
```

Companions:

- `zana_deliberation_status(deliberationId)` — current phase + vote tally
- `zana_deliberation_list({ filter })` — recent deliberations
- `zana_deliberation_override(deliberationId, decision, rationale)` — typed human override

### When to prefer Deliberation over manual fan-out

Reach for `zana_deliberate` instead of hand-rolled `zana_spawn_agent` × N + prose reconciliation when:

- You want **bounded, replayable** multi-perspective review (rounds capped, every vote content-addressed).
- You want to **surface dissent** rather than collapse it into a single orchestrator narrative.
- You want **a verdict** with an attached audit trail, not just a list of opinions.
- The decision matters enough to cost N parallel agents + synthesis + a convergence round.

Manual fan-out is still right for parallel research where you'll merge findings yourself. Deliberation is right when the merge step itself needs governance.

### Profile lens metadata

Voters can be picked by `lens` instead of `profileId`. The router (`resolveVoters` in `@zana/intelligence`) resolves a lens to concrete profile(s) at spawn time.

```
voters: [{lens: "security"}, {lens: "performance"}]
```

> **Note**: today `zana_deliberate` accepts string profileIds only. The `{lens: ...}` form is wired through `@zana/intelligence` but not yet plumbed into the MCP tool — see follow-up `FU-T11-c`. Until that lands, pass resolved profileIds (e.g. `"security-reviewer"`, `"performance-engineer"`).

Available lenses: `architecture`, `security`, `code-quality`, `testing`, `debugging`, `backend`, `frontend`, `research`, `docs`, `ux`, `performance`, `api-design`.

Coordination profiles (`orchestrator`, `swarm-master`, `swarm-orchestrator`, `full-auto-coder`) are intentionally lens-less — they coordinate, they don't review.

### Configuration

The deliberation runtime is configurable per-workspace via `zana_module_config_set("deliberation", "<key>", <value>)`. Keys:

- `defaultRounds` — convergence cap (default 2)
- `defaultQuorum` — `"majority"` | `"unanimous"` | `<N>`
- `defaultMode` — `"synthesis"` | `"tally"`
- `checkpointTTLDays` — how long a deliberation's checkpoint survives
- `occMaxRetries` — optimistic-concurrency retry budget on vote landing
- `probeTimeoutMs` — capability smoke-probe timeout per voter
- `probeRawMaxBytes` — max bytes captured from probe output for audit
- `synthesisSimilarityThreshold` — clustering threshold for consensus vs disagreement

### Concrete example

```
> /zana:council should we drop Node 18 in v3?
```

Runtime:

1. Spawns three voters by lens — architecture, security, performance.
2. Each independently emits APPROVE/CHANGES with rationale; votes land on the bus content-addressed.
3. Synthesis groups arguments. Architecture and performance agree (drop it — maintenance load, async perf wins on 20+); security raises CHANGES (an internal customer pinned to 18 for FedRAMP timeline).
4. One convergence round; security holds. Dissent preserved verbatim.
5. Verdict: `SETTLED` with dissent → auto-routed to `pending_human`. The human reads the minority report and decides; the override lands as a typed `deliberation:override` event.

The whole run is replayable from the event log + content-addressed rationales.

## Sprints vs ad-hoc tickets

Use a sprint when the work is bounded and you want a single completion signal across multiple tickets (a feature, a bug bash, a refactor). Use ad-hoc tickets when work trickles in or when tickets exist primarily for traceability and not coordination.

Always close sprints with `zana_sprint_end` once the tickets are done — open sprints accumulate noise and confuse autopilot loops that filter on sprint state.

## Sub-daemons vs in-process agents

In-process agents (`zana_spawn_agent`) share the parent daemon's resources, message bus, and lifetime. Light, fast, simple.

Sub-daemons (`zana_swarm_spawn`) are full child Zana processes with their own orchestrator and workers. Heavier, but they:

- Survive parent restarts
- Isolate failures
- Enable a master/worker hierarchy (one master, many child swarms)

Reach for sub-daemons only when you have multiple independent workstreams large enough to each justify their own team. For everything smaller, stay in-process.

## Common mistakes

- **Writing code yourself.** You are the orchestrator. If you find yourself editing source, you have already failed at delegation. Spawn a worker.
- **Vague prompts.** "Fix the bug" produces vague code. Specify files, criteria, and scope every time.
- **No context.** Workers do not see the conversation. Inline the relevant context (file paths, conventions, prior decisions) into the prompt.
- **Ignoring failures.** A worker that errors out needs diagnosis, not an immediate retry. Read its output, then respawn with a corrected prompt.
- **Spawning too many at once.** Past the concurrency cap, agents queue. Past your machine's capacity, everything slows. Start small, scale up only after the first wave completes cleanly.
- **Forgetting to close tickets.** Open tickets misrepresent progress and confuse autopilot evaluators.
