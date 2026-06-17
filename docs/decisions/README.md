# Architecture Decision Records

This directory holds Zana's **ADRs** — short, durable writeups of consequential
architecture and design decisions, and the post-mortems of incidents that
reshaped them.

An ADR exists so a decision is **discoverable and not re-litigated**. Rationale
that lives only in a commit message, an inline comment, or one person's head is
lost the moment the next contributor asks "why is it done this way?". When you
make a call that a future reader would reasonably question — a tradeoff, a
workaround, a constraint that looks wrong until you know the context — write it
down here.

## When to write one

Write an ADR when a decision:

- constrains how future code must be written (an invariant, a forbidden
  pattern, a required helper);
- looks wrong or surprising without context (a deliberate workaround, a
  "temporary" shape that's load-bearing);
- was expensive to learn (an incident, a data-loss bug, a footgun we hit);
- picks one approach where reasonable engineers would pick another.

Don't write one for routine, self-evident, or easily-reversible choices.

## Format

One file per decision, numbered: `NNNN-kebab-title.md`. Copy the shape of the
existing ADRs:

```
# ADR NNNN — Title

- **Status:** Accepted | Superseded by ADR-XXXX | Proposed
- **Date:** YYYY-MM-DD
- **Context:** What forced the decision — the problem, the constraint, what we
  observed.
- **Decision:** What we chose, stated as a rule.
- **Consequences:** What this buys us, what it costs, what to watch for.
```

Keep it to a page. Cite concrete files/paths. State the decision as a rule a
contributor can follow without re-deriving it.

ADRs are append-only in spirit: don't rewrite history. If a decision changes,
add a new ADR and mark the old one `Superseded by ADR-XXXX`.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-require-cycle-and-lazy-require.md) | The core↔work↔extras require-cycle and `lazyRequire` | Accepted |
| [0002](0002-tenant-isolation-workspace-context.md) | Tenant isolation via the workspace-context singleton | Accepted |
| [0003](0003-mcp-workspace-resolution.md) | MCP server workspace resolution (`ZANA_WORKSPACE` → cwd) | Accepted |
| [0004](0004-deliberation-convergence-rule.md) | Deliberation convergence: unanimity-within-latest-round | Accepted |
| [0005](0005-surface-daemon-tools-by-default.md) | Surface the daemon-path MCP tools by default | Accepted |
| [0006](0006-mcp-agent-registry-daemon-forwarding.md) | MCP server forwards agent lifecycle to the daemon when one exists | Accepted |
| [0007](0007-profile-model-tiering.md) | Cost-appropriate model tiering for agent profiles | Accepted |
| [0008](0008-ticket-automation-pipeline.md) | The ticket-automation pipeline (watcher rules, verdicts, escalation) | Accepted |
| [0009](0009-freeze-swarm-goap-vector-memory.md) | Freeze multi-daemon swarm, GOAP planner, and vector-memory | Accepted |
| [0010](0010-contracts-base-layer.md) | Extract the dependency-free base layer into @zana-ai/contracts | Accepted |
