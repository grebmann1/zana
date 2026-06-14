# ADR 0004 — Deliberation convergence: unanimity-within-latest-round

- **Status:** Accepted
- **Date:** 2026-06-12 (backfilled — the rule predates this ADR)

## Context

A Zana deliberation (council) runs N voters across up to N convergence rounds,
each voter emitting an APPROVE/CHANGES stance. Something has to decide when the
deliberation has *settled* versus when it must escalate to a human. The naive
choice — settle on a simple majority — quietly launders a held dissent into
approval: a 2-APPROVE / 1-CHANGES "majority" at the round cap would stamp the
result as approved while a reviewer's unresolved objection is still on the
table.

## Decision

`decide()` in `packages/work/src/deliberation/round-controller.ts` settles ONLY
when **every vote in the latest round is APPROVE** (`tally.changes === 0`). Any
CHANGES vote remaining at the round cap → ESCALATE with `cap_exhausted` (never
auto-pick a verdict at the cap — controller comment, line ~97).

The deliberation `quorum` field is a **participation** threshold (how many
voters must vote), **not** a majority threshold. These are different axes:
quorum gates whether the round counts; unanimity-within-the-latest-round gates
whether it settles.

## Consequences

- Dissent is never rubber-stamped away. A split at the cap forces a human to
  read the minority position — the intended governance property.
- A `cap_exhausted` outcome with split votes is **working as designed**, not a
  bug. When investigating one, the genuinely bug-shaped surfaces nearby are:
  voter parse-fallback rate (voters not emitting valid `{bit, rationale}` JSON)
  and quorum-vs-majority confusion in messaging/UI — not the convergence rule.
- Because unanimity is the bar, adding voters makes settling strictly harder,
  which is the correct direction for a governance gate.
