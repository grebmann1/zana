# ADR 0007 — Cost-appropriate model tiering for agent profiles

- **Status:** Accepted
- **Date:** 2026-06-17
- **Relates to:** ADR 0008 (the ticket-automation pipeline — auto-implement, triage gate, structured verdicts)

## Context

Most engineering profiles default to `claude-opus-4-8` (architect, backend-dev,
code-reviewer, debugger, researcher, test-writer, …). A fan-out squad is
therefore all-opus, even for work that does not need a frontier model. During
the 2026-06-16 orchestration dogfood, opus-tier tokens were spent on tasks like
confirming a ticket was already fixed — work a small model does fine.

Profiles already carry a `model` field, and two profiles (`slack-notifier`,
`triage-scout`) already use `claude-haiku-4-5`. We just lacked a stated policy
for which tier a profile should default to.

## Decision

Default a profile's `model` by the cognitive weight of its job:

| Tier | Model | Profiles / work |
|---|---|---|
| **Frontier** | `claude-opus-4-8` | Implementation, code/architecture review, debugging, design, deliberation judging — anything where a wrong answer is expensive. |
| **Cheap** | `claude-haiku-4-5-20251001` | Triage/staleness checks, notifications, single-tool relays, simple read-only lookups (`triage-scout`, `slack-notifier`). |

A profile that does real engineering reasoning stays on opus. A profile whose
job is a bounded, low-judgment read-or-relay should be haiku. When in doubt,
default to opus — correctness over cost — and demote only once the task is shown
to be cheap-model-safe.

Per-ticket override is out of scope for this decision (a `model:<tier>` label
honored by the spawn path was considered and deferred — not needed until a
concrete case demands a one-off override).

## Consequences

- Triage-class automation (the staleness gate that fronts the pipeline) runs on
  haiku, so guarding against wasted expensive spawns is itself cheap.
- New profiles must pick a tier deliberately; reviewers should flag an opus
  default on a bounded read/relay profile.
- No runtime mechanism change — `model` is already read by the spawn path. This
  ADR is policy, not code.
