# Orchestration

Orchestrate multi-agent workflows in Zana. You — the orchestrator — plan, delegate, and monitor. Workers do the implementation.

## Two paths: native (Claude Code) vs daemon (headless / CI)

Zana exposes the same primitives through two delivery paths. Pick the right one for the context.

| Path | When | How |
|---|---|---|
| **Native** (Claude Code session) | You are inside a Claude Code chat. The host owns orchestration; subagents live in the conversation. | `Agent({ name, subagent_type, run_in_background, prompt })` + `SendMessage({ to, summary, message })`. Slash command: `/zana:team <id> <prompt>`. |
| **Daemon** (headless / CI / scheduled) | No Claude Code chat is the orchestrator — a long-running daemon must drive the run from outside. | `mcp__zana__zana_start_team`, `mcp__zana__zana_spawn_agent`, etc. Used by `.zana/scheduler/*.yml` and external MCP callers. **These tools are gated** — see below. |

**Inside a Claude Code session, prefer native.** Spawning a daemon orchestrator from inside a Claude Code chat duplicates the orchestrator role, burns extra tokens, and hides worker progress behind MCP polling. Use `mcp__zana__zana_start_team` only when you genuinely need a process that survives the Claude Code session ending — e.g., a cron-driven autopilot.

> **Daemon-tool gate.** As of 0.1.5 the daemon-only MCP tools (`zana_spawn_agent*`, `zana_kill_agent`, `zana_agent_status`, `zana_agent_result`, `zana_list_agents`, `zana_oneshot_query`, `zana_start_team`, `zana_stop_team`, `zana_team_status`, `zana_list_running_teams`, `zana_ask_agent`, `zana_check_inbox`, `zana_send_ack`, `zana_autopilot_goal_*`, `zana_deliberate*`) are **hidden by default** to keep the Claude Code surface lean. They appear in `tools/list` and become callable only when the MCP server is launched with `ZANA_DAEMON_TOOLS=1` in its env (mirroring `ZANA_MASTER_MODE=true` for the swarm tools). Headless / CI / cron callers should set both flags; chat-driven users typically need neither — the slash commands cover everything.

The rest of this guide describes both, called out per section.

## When to spawn one agent vs a team

Spawn a **single agent** when the task is well-scoped to a few files and one specialty (one bug fix, one component, one doc page).
- Native: `Agent({ subagent_type: "general-purpose", prompt: "..." })` (or `Plan` / `Explore` / a plugin subagent type as appropriate).
- Daemon: `zana_spawn_agent` with the right profile and a tight prompt.

Spawn a **team** when the task crosses concerns or benefits from parallelism: planning + implementation + tests, or three independent features that can ship in parallel.
- Native: `/zana:team <id> <prompt>` — renders the template into named `Agent` calls + a `SendMessage` kickoff. Or hand-roll: spawn N named agents in ONE message with `run_in_background: true`, each agent's prompt names who it `SendMessage`s next, then issue ONE `SendMessage` to the head of the pipeline.
- Daemon: `mcp__zana__zana_start_team` (or multiple `zana_spawn_agent` calls — one per role).

For very large multi-workstream efforts that need to span workspaces or survive process restarts, see the **Sub-daemon swarms** appendix at the bottom of this guide. Inside Claude Code you almost never need them — `Agent({ run_in_background: true })` already isolates per-agent context.

## Breaking a task into tickets

Before spawning anyone, decompose. A useful ticket is:

- Independent (can be assigned to one worker without blocking others)
- Small (fits inside one agent's context plus a margin for tools and tests)
- Verifiable (has an acceptance criterion you can check from outside)

Use `zana_ticket_create` for each piece, then `zana_sprint_create` to group them and `zana_sprint_start` to begin. Tickets are not bureaucracy — they are the unit of dispatch and the thing you mark `complete` so the orchestration loop stays honest about progress.

## The review pipeline (auto-driven — daemon path only)

The ticket watcher described here runs **in the daemon**. Inside a Claude Code session with no daemon attached, `zana_ticket_update_status({ status: "review" })` does NOT auto-spawn a reviewer — you must spawn the reviewer yourself via `Agent` (or rely on the host's own review skill). The auto-driven pipeline below applies when a daemon is running and the watcher is subscribed (default for `zana headless`).

Once a ticket is in `review`, the daemon's ticket watcher (`packages/work/src/tickets/watcher.ts`) runs the cycle on autopilot. You don't have to dispatch a reviewer — the daemon does it. You DO have to know the contract.

State graph the watcher enforces:

```
backlog → in-progress → review → done
                          ↓ ↑
                       rework (auto re-spawn original assignee)
                          ↓ (after 3 cycles)
                       blocked (human required)
```

Default automation rules (loaded at daemon start):

| Trigger | Action | Agent prompt expects |
|---|---|---|
| `status: review`, `reviewPhase: qa` | spawn `code-reviewer` | `VERDICT: PASS` → advance to architecture phase; `VERDICT: FAIL` → rework |
| `status: review`, `reviewPhase: architecture` | spawn `architect` | `VERDICT: PASS` → done; `VERDICT: FAIL` → rework |
| `status: rework` | spawn `{{assigneeProfileId}}` (the original worker) | `VERDICT: READY` → re-enter review (qa); `VERDICT: BLOCKED <reason>` → blocked |

Hard limit: 3 rework cycles → ticket auto-blocks with comment "BLOCKED: failed review 3 times" and emits `ticket:blocked` event for human triage.

What this means for you, the orchestrator:

- After spawning the implementer, **`zana_ticket_update_status({ ticketId, status: "review" })` is the hand-off** — the QA reviewer auto-spawns *if the daemon's watcher is running*. Do not manually spawn a `code-reviewer` after the implementer in that case; the watcher will, and you'll double-spawn. On the native path (no daemon), spawn the reviewer yourself via `Agent`.
- **Worker prompts must end in a `VERDICT:` line** when they're spawned by a watcher rule. Inspect the rule's `promptTemplate` if unsure (`zana ticket rules list`). Workers spawned directly by you don't need a verdict — only watcher-spawned ones do.
- If the user wants to **skip auto-review** for a ticket (e.g., trivial doc fix), close it from `in-progress → done` with `zana_ticket_update_status` directly. Skipping review is a deliberate choice, not the default.
- If a ticket lands in `blocked`, treat it like a deliberation escalation: read the comments, then either `zana_ticket_update_status` to `in-progress` with a corrective spawn, or `cancelled` if the work was wrong.
- `zana ticket rules list` (CLI) shows the loaded rules + any validation warnings. Useful when default rules feel surprising.

There is **no auto-claim from backlog** — `backlog → in-progress` is always orchestrator-initiated. If you want a "QA agent picks up qa-tagged tickets" flow, you'd `zana_ticket_list({ label: "qa", status: "backlog" })` and dispatch yourself.

## The execution path

You drive every step. The orchestrator plans, dispatches, and verifies — Zana does not guess about success on your behalf.

**Native path** (inside Claude Code):
1. Decide the roster — what specialties, how many of each. `zana_list_profiles` is still useful for discovering available role personas (their `systemPrompt` becomes part of the per-agent prompt).
2. Spawn ALL agents in ONE message with `run_in_background: true` and `name:` set on each. Each prompt names who to `SendMessage` next.
3. Issue ONE `SendMessage` to the head of the pipeline. Stop.
4. Agents message back as they finish. Don't poll — `SendMessage` traffic surfaces in the host conversation.

**Daemon path** (headless / CI):
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

**Native**: agents stream their progress into the host conversation; `SendMessage` deliveries surface there too. There is nothing to poll. If you need to inspect or kill a subagent, use Claude Code's built-in `/agents` controls — Zana has no handle on native subagents because it didn't spawn them.

> **Nested subagents and SendMessage availability.** Top-level subagents spawned by the host conversation (`Agent({...})`) have native `SendMessage` in their tool environment. Subagents that themselves were spawned by a parent subagent (e.g. council voters spawned by an outer orchestrator subagent) may NOT have native `SendMessage` — only the MCP fallback `mcp__zana__zana_send_message`. The fallback now accepts `toAgentName` (resolves by active-agent name) so addressing-by-name still works without a UUID. For strict cases (nested council voters that can't reach the synthesizer), the safe pattern is "voters return their stance as final assistant message; host collects all and spawns the synthesizer with the verbatim text inlined" — that's exactly what `/zana:council` and `/zana:council:arch` do today.

**Daemon**: `zana_list_agents` returns lightweight status. `zana_agent_status(agentId)` gives detail. `zana_agent_result(agentId)` returns the agent's final message and any structured output once `state === "terminated"`. If an agent stalls, kill it (`zana_kill_agent`) and respawn with a sharper prompt. Don't pile on retries with the same prompt — it failed for a reason.

Two patterns work for both paths:

- **Fan-out, gather**: spawn N independent agents in parallel, then collect results. Native: all agents `SendMessage` back to a single named "collector" subagent (or to the host). Daemon: poll until all are terminated, then call `zana_agent_result` in order.
- **Pipeline**: A → B → C. Native: each agent's prompt names the next via `SendMessage`. Daemon: spawn A, await its result, feed it into B's prompt, repeat.

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

(See `plugins/zana/core/commands/council.md` for the slash sugar.)

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

Voters can be picked by `lens` instead of `profileId`. The router (`resolveVoters` in `@zana-ai/intelligence`) resolves a lens to concrete profile(s) at spawn time.

```
voters: [{lens: "security"}, {lens: "performance"}]
```

> **Note**: today `zana_deliberate` accepts string profileIds only. The `{lens: ...}` form is wired through `@zana-ai/intelligence` but not yet plumbed into the MCP tool — see follow-up `FU-T11-c`. Until that lands, pass resolved profileIds (e.g. `"security-reviewer"`, `"performance-engineer"`).

Available lenses: `architecture`, `security`, `code-quality`, `testing`, `debugging`, `backend`, `frontend`, `research`, `docs`, `ux`, `performance`, `api-design`.

Coordination profiles (`orchestrator`, `full-auto-coder`, plus `swarm-master` / `swarm-orchestrator` — only relevant under `ZANA_MASTER_MODE`, see appendix) are intentionally lens-less — they coordinate, they don't review.

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

## Autopilot

Use **autopilot** when the user wants a *verified outcome*, not just a list of subtasks: a goal + ordered steps + an evaluator that loops until the criteria pass or the iteration cap is hit. Manual fan-out gives you results to read; autopilot gives you a closed loop.

### When to use autopilot vs a team

- **Autopilot**: there is a single measurable success criterion ("tests pass", "no `logger.*` call sites remain", "the API contract validates against schema X"). The evaluator can decide PASS/FAIL by reading agent output.
- **Team**: open-ended exploration, design work, anything where "done" is a judgment call. Autopilot has nothing to evaluate against.

### How to invoke

```
zana_autopilot_goal_driven({
  title: "Migrate logger calls to structured format",
  criteria: "Every logger.* call in packages/server/src/ uses structured fields. Tests pass.",
  steps: [
    { profile: "researcher",   prompt: "List every logger.* call site under packages/server/src/. Output JSON: [{file,line,call}]." },
    { profile: "backend-dev",  prompt: "Convert each call from the previous step's output to structured logging." },
    { profile: "test-writer",  prompt: "Add a test that fails on a regex-style logger.* match in packages/server/src/." }
  ]
})
// → { goalId: "goal_xyz" }
```

Each iteration runs all steps in order, then spawns the evaluator profile (default `code-reviewer`) with the goal title, criteria, and a results summary. The evaluator must emit a line matching `VERDICT: PASS` for the goal to settle.

### Polling

```
zana_autopilot_goal_status({ goalId: "goal_xyz" })
// → { status, iteration, results, lastEvaluation }
```

Status enum: `running` → `completed` (PASS) | `exhausted` (cap hit without PASS) | `failed` (profile lookup or spawn error) | `cancelled` (manual). Poll until `status !== "running"`.

`zana_autopilot_goal_list({ status })` to enumerate; `zana_autopilot_goal_cancel({ goalId })` to abort an in-flight loop.

### Configuration

Per-workspace knobs via `zana_module_config_set("autopilot", "<key>", "<value>")`:

- `maxIterations` — full step-sequence repeat cap (default 5)
- `evaluatorProfile` — profile that judges PASS/FAIL (default `code-reviewer`; the `judge` profile is a stricter alternative)

If the loop exhausts, read `results[]` and `lastEvaluation` to diagnose — usually the failure mode is either "criteria are unfalsifiable" or "evaluator can't see the artifact it needs to judge". Tighten one or the other and rerun, don't just bump `maxIterations`.

### Discovery — gather context before invoking

The single biggest cause of an exhausted goal is a vague invocation. Autopilot has no native discovery phase: `zana_autopilot_goal_driven` assumes `criteria` and `steps` are already concrete. **You** are the discovery phase.

Before the tool call, run a discovery pass — either inline with the user, or via `/zana:autopilot:discover` for a structured walkthrough:

1. **Restate the goal** as a one-line imperative. "Make the build faster" → "Cut `npm run build` wall-clock from 90s to <30s."
2. **Force-falsifiable criteria**. If the user says "looks good" or "robust", push back: "What specific check would tell us we're done?" Tests passing, a metric below a threshold, a regex-style absence — these the evaluator can judge. "Looks good" — it cannot.
3. **Locate the work**. File paths, package names, the git ref baseline. Workers spawn with no conversation context; the prompt is everything they see.
4. **Confirm scope boundaries**. What is *out of scope* — what should the worker NOT touch?
5. **Pick step shapes**. 1–3 steps, each one specialty (researcher → coder → test-writer is a common shape). Don't pre-specify how each step solves the problem; specify what each step must produce.
6. **Echo the plan back to the user** before invoking. One block: title, criteria, steps. Wait for confirmation.

If any of these are uncertain after one pass at the user, ask follow-ups before invoking. Autopilot iterations are expensive — five iterations of a vague goal cost ~10× one round of clarification.

### Memory — pre-flight and post-mortem

Vector memory (`zana_memory_search` / `zana_memory_store`) lets autopilot improve over time. Two patterns:

**Pre-flight, before invoking:**

```
zana_memory_search({ query: "<title verbatim>", limit: 3 })
// → [{ content, tags, score, ... }]
```

If a similar prior goal succeeded, lift its `criteria` shape and the step profiles that worked. If it `exhausted`, read why — usually a missing constraint that the new goal can bake in.

**Post-mortem, after the goal lands:**

```
zana_memory_store({
  content: "Goal: <title>. Outcome: <completed|exhausted>. Iterations: <n>. Working steps: <profiles>. Lesson: <one sentence>.",
  tags: ["autopilot", "<status>"]
})
```

Store every terminal goal, success or failure. The store is what makes the next autopilot smarter; without it every run starts from zero.

### Tickets-as-evidence

For consequential autopilot runs (anything that mutates the codebase), wrap each step in a ticket so failures are debuggable:

```
// Before invoking:
const t1 = zana_ticket_create({ title: "Step 1: list logger.* call sites", priority: "low", labels: ["autopilot"] });
const t2 = zana_ticket_create({ title: "Step 2: convert to structured logging", priority: "low", labels: ["autopilot"] });
const t3 = zana_ticket_create({ title: "Step 3: add regression test", priority: "low", labels: ["autopilot"] });

// Then in each step's prompt, include:
//   "When done, call zana_ticket_complete({ ticketId: 't_X', resultSummary: '...' })."
```

This gives you four wins:

1. `zana_ticket_list({ labels: ["autopilot"] })` reconstructs the run if the goal is `exhausted` and the in-memory `results[]` is gone.
2. The result summaries become CAS-stored evidence the evaluator can quote in `lastEvaluation`.
3. If a step's ticket lands in `rework` (because the watcher's QA reviewer caught a bug), the next autopilot iteration sees a richer history.
4. The user gets a paper trail in `zana_ticket_list` that doesn't disappear with the goal.

Skip tickets for one-shot read-only goals (research, gather-and-summarize) — the overhead isn't worth it.

### Deliberation as evaluator (high-risk goals)

Default evaluator is a single `code-reviewer` agent. For goals where one judge is too thin a signal — schema migrations, security-sensitive changes, anything with `riskTag: "high"` — consider running deliberation manually after each iteration instead of relying on the built-in evaluator:

```
// After your steps complete (NOT via autopilot — orchestrator-driven):
zana_deliberate({
  question: "Does the iteration's output meet: <criteria>?",
  voters: ["architect", "security-reviewer", "test-writer"],
  rounds: 2,
  riskTag: "high",     // forces human-in-the-loop on dissent
  context: { resultSummaries: [...] }
})
```

This is a bigger pattern — you're hand-rolling the loop. Use it when the cost of a wrong PASS is high. For routine goals stick with the built-in evaluator and a tightened `evaluatorProfile: "judge"`.

### What autopilot does NOT do (orchestrator must own these)

- **Persistence across daemon restart**: goals are in-memory. If the daemon dies mid-run the goal is lost. Use the tickets-as-evidence pattern above for anything important.
- **Auto-clarify**: there's no "ask the user before starting" hook — that's the discovery phase, your responsibility.
- **Auto-respawn on exhaustion**: when status flips to `exhausted` the loop stops. Either call again with tightened criteria, or hand off to a human.
- **Schedule integration**: autopilot is one-shot. For continuous quality gates ("re-verify the criteria every hour") author a `.zana/scheduler/<id>.yml` with a `spawn-agent` action that runs the evaluator prompt — see the scheduler skill.

## Sprints vs ad-hoc tickets

Use a sprint when the work is bounded and you want a single completion signal across multiple tickets (a feature, a bug bash, a refactor). Use ad-hoc tickets when work trickles in or when tickets exist primarily for traceability and not coordination.

Always close sprints with `zana_sprint_end` once the tickets are done — open sprints accumulate noise and confuse autopilot loops that filter on sprint state.

## Monitoring tickets and sprints — use the status-line footer

Ticket and sprint state changes asynchronously: workers transition tickets `backlog → in-progress → review → done`, the watcher escalates failed reviews into `rework` or `blocked`, and autopilot writes new tickets while you sleep. Polling that by hand (`/zana:ticket:list` every few seconds, or `zana_sprint_board` on a loop) is wasted bandwidth and burns context for noise.

Wire the Claude Code **status-line footer** instead. It reads `.zana/tickets.db` directly and surfaces live counts as `tickets: N doing · N review · N blocked · N todo` plus daemon/schedule state. Configure once in `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node \"<path-to-zana>/packages/core/dist/bin/statusline.js\"",
  "padding": 1,
  "refreshInterval": 30
}
```

The footer refreshes on every prompt and every `refreshInterval` seconds (set this to 30 or lower for active orchestration). Once it's wired:

- **Glance, don't query.** The footer answers "is anything still in flight?" without calling a tool. Re-run `/zana:ticket:list` only when you need *which* tickets, not *how many*.
- **`blocked > 0` is the alarm.** A non-zero `blocked` count means a ticket exhausted its rework cycles and needs human triage — open the board, read the audit trail, decide.
- **`review` lingering is a signal.** If `review` stays non-zero across multiple footer refreshes, the watcher's reviewer is stuck or the review prompt needs sharpening. Inspect the ticket's comment history before respawning.

Ask for a fresh status only when the footer disagrees with what you expect, or when you need ticket titles/ids the footer can't show.

## Common mistakes

- **Spawning a daemon orchestrator from inside Claude Code.** Calling `zana_start_team` or `zana_spawn_agent` inside a Claude Code session creates a *second* orchestrator that duplicates your role and burns extra tokens. Use `/zana:team` (native path) or hand-roll `Agent` + `SendMessage`. Reserve the daemon-spawning tools for headless callers.
- **Writing code yourself.** When you've decided to delegate, stay delegated. If you find yourself editing source while a team is running, you've collapsed back into a solo orchestrator and the workers are now redundant.
- **Sequential `Agent` calls when a pipeline is meant.** Spawn ALL agents in ONE tool-use block — sequential calls block parallel pipelines and force you to babysit handoffs the agents can do themselves via `SendMessage`.
- **Vague prompts.** "Fix the bug" produces vague code. Specify files, criteria, and scope every time.
- **No context.** Workers do not see the conversation. Inline the relevant context (file paths, conventions, prior decisions) into the prompt.
- **Ignoring failures.** A worker that errors out needs diagnosis, not an immediate retry. Read its output, then respawn with a corrected prompt.
- **Spawning too many at once.** Past the concurrency cap, agents queue. Past your machine's capacity, everything slows. Start small, scale up only after the first wave completes cleanly.
- **Forgetting to close tickets.** Open tickets misrepresent progress and confuse autopilot evaluators.

---

## Appendix: Sub-daemon swarms (advanced — headless only)

Sub-daemon swarms exist for one specific niche: long-running, cross-workspace, multi-workstream efforts that need their own process boundary so the parent process can restart without losing them. Inside a Claude Code session, this is almost never the right tool — `Agent({ run_in_background: true })` already gives you isolated per-agent context, and "survive parent restart" isn't meaningful for a chat session.

**When sub-daemons are the right call**: a master daemon driving N independent epics in parallel across machines or workspaces, where each epic needs its own orchestrator + workers and must survive the master's failures.

**When they're the wrong call**: anything inside a Claude Code session, or any team of <10 agents on one machine. Use the native path (`/zana:team` or hand-rolled `Agent` + `SendMessage`) or the in-process daemon path (`zana_spawn_agent`, `zana_start_team`) instead.

**Surface** (gated behind `ZANA_MASTER_MODE=true`):
- `zana_swarm_spawn(teamId, prompt)` — spawn a child daemon with its own orchestrator + workers
- `zana_swarm_list` — child-daemon status
- `zana_swarm_instruct(daemonId, message)` — instructions flow DOWN only (master → team lead → workers)
- `zana_swarm_broadcast(message)` — fan an instruction to every child team lead
- `zana_swarm_stop(daemonId)` — kill a child daemon
- `zana_swarm_poll_events(since)` — progress updates

The `swarm-master` / `swarm-orchestrator` profiles exist solely to delegate via `zana_swarm_spawn`. They are gated behind `ZANA_MASTER_MODE=true` and are not useful on the native path.
