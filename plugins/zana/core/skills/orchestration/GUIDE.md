# Orchestration

Orchestrate multi-agent workflows in Zana. You — the orchestrator — plan, delegate, and monitor. Workers do the implementation.

## When to spawn one agent vs a team

Spawn a **single agent** when the task is well-scoped to a few files and one specialty (one bug fix, one component, one doc page). Use `zana_spawn_agent` with the right profile and a tight prompt.

Spawn a **team** when the task crosses concerns or benefits from parallelism: planning + implementation + tests, or three independent features that can ship in parallel. Use `zana_start_team` (one of the templates) or build your own composition with multiple `zana_spawn_agent` calls.

Spawn a **child daemon swarm** (`zana_swarm_spawn`) only when each workstream is large enough to warrant its own orchestrator and workers — typically multi-day efforts or independent epics. In-process agents are cheaper for everything else.

## Breaking a task into tickets

Before spawning anyone, decompose. A useful ticket is:

- Independent (can be assigned to one worker without blocking others)
- Small (fits inside one agent's context plus a margin for tools and tests)
- Verifiable (has an acceptance criterion you can check from outside)

Use `zana_ticket_create` for each piece, then `zana_sprint_create` to group them and `zana_sprint_start` to begin. Tickets are not bureaucracy — they are the unit of dispatch and the thing you mark `complete` so the orchestration loop stays honest about progress.

## The two execution paths

### Manual orchestration

You drive every step. Use this when the task is novel, the workers need careful prompts, or the success signal needs your judgement.

1. `zana_list_profiles` to see who is available.
2. `zana_spawn_agent` per ticket. Spawn independent tickets in parallel up to the concurrency cap (default 10).
3. `zana_list_agents` periodically to monitor.
4. `zana_agent_result` once an agent terminates — verify the work is real.
5. `zana_ticket_complete` with a result summary.

### Goal-driven autopilot

Hand the loop to Zana. Use this when the goal is specific and the success criteria are checkable. Call `zana_autopilot_goal_driven` with:

- `title`: what is being achieved
- `criteria`: an explicit list of conditions an evaluator can grade
- `steps`: ordered `{prompt, profile}` agent runs

The system spawns workers, runs an evaluator after each pass, and restarts from step 0 if the criteria fail. You walk away.

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
