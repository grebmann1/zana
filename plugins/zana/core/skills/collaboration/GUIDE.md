# Collaboration

Coordination primitives between Zana agents. Use these when an agent needs to talk to other agents, share context, or hand off work without the orchestrator brokering every message.

## Inboxes — direct messages between agents

Each agent has an inbox identified by its agent ID (or a stable name).

- `zana_send_message(to, summary, message)` — drop a message into another agent's inbox.
- `zana_check_inbox()` — list pending messages addressed to the current agent.

Use this for targeted, low-volume traffic: "researcher → architect: here are the findings" or "tester → coder: tests for `foo` fail in this case." Inboxes are persistent; messages survive a daemon restart.

Patterns:

- **Hand-off**: A finishes a phase, sends a single summary to B with the artifacts B needs. B drains its inbox at the start of its run and proceeds.
- **Request/reply**: A sends a message tagged with a `replyTo` field. B sends back to that ID. Use `zana_send_ack` to confirm receipt explicitly when ordering matters.

## Channels — pub/sub coordination

Channels are named topics any agent can publish to or subscribe to.

- `zana_publish_channel(channel, message)` — emit a message on a topic.
- `zana_subscribe_channel(channel)` — register the current agent as a subscriber.
- `zana_channel_history(channel, limit)` — fetch the last N messages, useful for newcomers catching up.
- `zana_list_channels()` — discover what channels exist.

Use channels when many agents care about the same stream of events (e.g., `build:results`, `tickets:updated`, `swarm:progress`). Prefer channels over inbox fan-out — one publish reaches every subscriber and the channel keeps history for late joiners.

## Acknowledgments and request/reply

For workflows where an agent must know its message landed:

1. Sender includes a correlation ID in the message body.
2. Receiver processes the work and calls `zana_send_ack(correlationId, status, payload)`.
3. Sender polls `zana_check_inbox` for the matching ack.

Treat acks as advisory, not transactional. The system does not retry failed sends — your agent does.

## Shared memory and artifacts

Inboxes and channels are for short messages. For anything bigger than a paragraph, use artifacts.

- `zana_artifact_create(title, type, content)` — store a versioned blob (architecture-doc, requirement-spec, design-doc, etc.). Returns an `artifactId`.
- `zana_artifact_list()` — discover existing artifacts.
- `zana_artifact_read(artifactId)` — fetch the full content.
- `zana_artifact_update(artifactId, content)` — bump to a new revision.

Pattern: an architect agent produces a design as an artifact, sends only the artifact ID via inbox to the implementer, and the implementer reads the artifact when it starts. This keeps inboxes tidy and creates an audit trail.

For ephemeral key/value storage that doesn't deserve a full artifact, use `zana_memory_store(key, value)` and `zana_memory_search(query)`. Memory is project-scoped and indexed for fuzzy lookup.

## Checkpoints — resumable workflows

Long-running coordination (multi-step pipelines, autopilot loops) should checkpoint progress so a daemon restart doesn't lose state.

- `zana_checkpoint_save(workflowId, state)` — persist named state.
- `zana_checkpoint_list(workflowId)` — enumerate available checkpoints.
- `zana_checkpoint_get(checkpointId)` — fetch one checkpoint.
- `zana_checkpoint_resume(checkpointId)` — resume a workflow from a saved state.

Save a checkpoint after each phase that completes successfully (research done, plan written, code written, tests green). On restart, find the latest checkpoint for the workflow and resume.

## Event coordination

Beyond directed messages, agents can emit and query a shared event log.

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
