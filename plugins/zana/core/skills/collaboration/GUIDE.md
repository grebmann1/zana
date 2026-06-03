# Collaboration

Coordination primitives between Zana agents. Use these when an agent needs to talk to other agents, share context, or hand off work without the orchestrator brokering every message.

## Two paths: native (Claude Code) vs daemon

Inside a Claude Code session, the native primitive is `SendMessage({ to, summary, message })` — a built-in tool delivered to a named subagent's inbox in this conversation. Spawn agents with `Agent({ name, ..., run_in_background: true })` and they can `SendMessage` each other freely. For anything bigger than a paragraph, just inline the context into the next agent's `prompt` — Claude Code subagents share the host conversation's filesystem, so artifacts are usually unnecessary.

The Zana MCP collaboration tools below (`zana_send_message`, `zana_check_inbox`, `zana_publish_channel`, `zana_artifact_*`, `zana_memory_*`, `zana_event_*`, `zana_checkpoint_*`) target **daemon-spawned agents** that don't have access to Claude Code's native tools. Use them when:

- The agent was spawned via `mcp__zana__zana_spawn_agent` or `mcp__zana__zana_start_team` (headless / CI / scheduled / cron).
- The collaboration must outlive the Claude Code session (persistent inboxes, multi-day artifacts).
- Many agents across many daemons need to share a topic (`zana_publish_channel`).

Inside a Claude Code chat the simple rule is: **prefer `SendMessage` for messaging and inline prompts for context**. Reach for the daemon-side tools only when the agents themselves can't see Claude Code's native primitives.

## Inboxes — direct messages between agents (daemon path)

Each daemon-spawned agent has an inbox identified by its agent ID (or a stable name). Native Claude Code subagents use `SendMessage` instead — these tools are for the daemon side.

- `zana_send_message` — drop a typed message into another agent's inbox.
- `zana_check_inbox` — list pending messages addressed to the current agent.

```
zana_send_message({
  toAgentId: "ag_42",
  type: "handoff",
  payload: { kind: "handoff", ticketId: "tkt_abc", content: "Schema design ready — see artifact art_77." },
  requiresAck: true
})
zana_check_inbox({})
// → [{ from, type, payload, ts, messageId }]
```

Use this for targeted, low-volume traffic: "researcher → architect: here are the findings" or "tester → coder: tests for `foo` fail in this case." Inboxes are persistent; messages survive a daemon restart.

Patterns:

- **Hand-off**: A finishes a phase, sends a single summary to B with the artifacts B needs (`type: "handoff"`, `payload.kind: "handoff"`, attach `ticketId`). B drains its inbox at the start of its run and proceeds.
- **Request/reply**: A sends `type: "question"` with `requiresAck: true` and a stable correlation ID in `payload.content`. B replies via `zana_send_ack({ messageId, status, response })`.

## Channels — pub/sub coordination (daemon path)

Channels are named topics any daemon agent can publish to or subscribe to. Native subagents inside a Claude Code chat don't need channels — they `SendMessage` each other directly.

- `zana_publish_channel` — emit a typed message on a topic.
- `zana_subscribe_channel` — register the current agent as a subscriber.
- `zana_channel_history` — fetch the last N messages, useful for newcomers catching up.
- `zana_list_channels` — discover what channels exist.

```
zana_publish_channel({
  channel: "build:status",
  type: "status",
  payload: { kind: "structured", data: { ok: true, sha: "abc123", durationMs: 8421 } }
})
zana_subscribe_channel({ channel: "build:status" })
zana_channel_history({ channel: "build:status", limit: 20 })
```

Use channels when many agents care about the same stream of events (e.g., `build:status`, `tickets:updated`, `swarm:progress`). Prefer channels over inbox fan-out — one publish reaches every subscriber and the channel keeps history for late joiners.

## Acknowledgments and request/reply

For workflows where an agent must know its message landed:

1. Sender includes a correlation ID in the message body.
2. Receiver processes the work and calls `zana_send_ack(correlationId, status, payload)`.
3. Sender polls `zana_check_inbox` for the matching ack.

Treat acks as advisory, not transactional. The system does not retry failed sends — your agent does.

## Shared memory and artifacts (daemon path)

Inboxes and channels are for short messages. For anything bigger than a paragraph, daemon agents use artifacts. Native Claude Code subagents typically just inline file paths into the next agent's prompt — they share the host conversation's filesystem and don't need a separate blob store.

- `zana_artifact_create` — store a versioned blob (architecture-doc, requirement-spec, design-doc, etc.). Returns an `artifactId`.
- `zana_artifact_list` — discover existing artifacts.
- `zana_artifact_read` — fetch the full content.
- `zana_artifact_update` — bump to a new revision.

```
zana_artifact_create({
  title: "Auth schema v2",
  type: "design-doc",
  content: "# Auth schema v2\n\n…",
  tags: ["auth"],
  linkedTickets: ["tkt_abc"]
})
// → { artifactId: "art_77", … }
zana_artifact_read({ artifactId: "art_77" })
```

Pattern: an architect agent produces a design as an artifact, sends only the artifact ID via inbox to the implementer (`payload.content` references `art_77`), and the implementer reads the artifact when it starts. This keeps inboxes tidy and creates an audit trail.

For ephemeral key/value storage that doesn't deserve a full artifact, use `zana_memory_store(key, value)` and `zana_memory_search(query)`. Memory is project-scoped and indexed for fuzzy lookup.

## Checkpoints — resumable workflows (daemon path)

Long-running daemon coordination (multi-step pipelines, autopilot loops) should checkpoint progress so a daemon restart doesn't lose state. Native Claude Code teams have no equivalent — if the host conversation ends, the run ends; for resumable workflows use the daemon path.

- `zana_checkpoint_save` — persist a snapshot of a team run, including the agents that still need to spawn.
- `zana_checkpoint_list` — enumerate checkpoints, optionally filtered by `teamId` or `status`.
- `zana_checkpoint_get` — fetch full detail for one checkpoint.
- `zana_checkpoint_resume` — re-spawn the pending agents from a checkpoint with the completed agents' output as context.

```
zana_checkpoint_save({
  teamId: "team_42",
  pendingAgents: [
    { profileId: "test-writer", prompt: "Add tests for the auth changes from ag_42 above.", dependencies: ["ag_42"] }
  ]
})
// → { checkpointId: "ckpt_abc" }

// Later — same or fresh daemon:
zana_checkpoint_list({ teamId: "team_42", status: "stopped" })
zana_checkpoint_resume({ checkpointId: "ckpt_abc" })
```

Save a checkpoint after each phase that completes successfully (research done, plan written, code written, tests green). On restart, list checkpoints for the workflow and resume the latest stopped one.

## Event coordination (daemon path)

Beyond directed messages, daemon agents can emit and query a shared event log. Native Claude Code subagents don't need this — `SendMessage` already creates a per-agent message log readable in the host conversation.

- `zana_event_emit(type, payload, tags)` — record a structured event.
- `zana_event_query(filter)` — query recent events by type, tag, or time.

Use events for telemetry-style coordination: "agent X finished," "build Y failed," "ticket Z claimed." Events are append-only and good for retrospective analysis or for a late-arriving agent catching up on what already happened.

## See also

For protocolized multi-voice consensus — bounded N voters, synthesis with verbatim dissent, content-addressed audit trail, and a typed verdict — see **Deliberation** in `plugins/zana/core/skills/orchestration/GUIDE.md`. Inboxes and channels are for ongoing chatter; deliberation is for one-shot governance.

## Best practices

- **Prefer artifacts for large payloads.** Inboxes and channels are not blob storage. Anything over a few paragraphs belongs in an artifact; pass the ID instead.
- **Make handlers idempotent.** Messages can be redelivered after a restart. Treat duplicate reception as expected and de-dupe by correlation ID.
- **Don't chat — hand off.** Two agents bouncing 20 messages back and forth is a smell. Either give one of them the full context up front, or merge them into a single agent.
- **Use channels for many-to-many, inboxes for one-to-one.** Reaching for the wrong primitive creates noise.
- **Prune subscriptions.** If your agent no longer needs a channel, unsubscribe — daemons that subscribe to everything become bottlenecks.
- **Checkpoint at phase boundaries, not every tool call.** Too-frequent checkpoints add I/O without buying recoverability.
- **Treat the inbox as a queue, not a chat log.** Drain it at the start of each tick, act on each message, then move on.
- **Keep messages structured.** A consistent JSON shape (e.g., `{ kind, correlationId, payload }`) is easier for downstream agents to parse than free-form prose.
