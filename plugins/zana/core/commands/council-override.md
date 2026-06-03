---
name: zana:council:override
description: Record a human override on a deliberation — approve, reject, or rework — with a written reason. Lands the deliberation on SETTLED.
argument-hint: <deliberationId> <approve|reject|rework> <reason>
allowed-tools: mcp__zana__zana_deliberation_status mcp__zana__zana_deliberation_override
---

# /zana:council:override

Record a human override. **Daemon path only** — native councils convened via `/zana:council` don't have a daemon-side audit record; if the synthesizer returned an unsatisfying verdict, just respond directly in the host conversation or convene a fresh council.

The reason is content-addressed and stamped onto the deliberation. The deliberation lands on SETTLED with the override decision.

`$ARGUMENTS` is `<deliberationId> <approve|reject|rework> <reason...>`.

## Workflow

1. **Parse** `$ARGUMENTS` — split on whitespace into:
   - `deliberationId` (first token; UUID)
   - `decision` (second token; one of `approve` | `reject` | `rework`)
   - `reason` (remainder; everything after the second token, trimmed; required, non-empty)
2. **Validate**:
   - If any of the three is missing, tell the user the expected shape and stop.
   - If `decision` isn't one of the three values, list the valid options and stop.
3. **(Optional) Pre-flight** — call `mcp__zana__zana_deliberation_status` to confirm the deliberation exists and show its current state to the user before mutating. If it's already SETTLED with an override, warn the user and ask for confirmation.
4. **Override** — call `mcp__zana__zana_deliberation_override` with:
   ```
   {
     "deliberationId": "<deliberationId>",
     "decision": "<decision>",
     "reason": "<reason>"
   }
   ```
5. **Render** the result:
   - Confirmation that the override was recorded
   - The `humanOverride` block from the returned deliberation (humanId, decision, reasonHash, ts)
   - New `state` (should be SETTLED) and `verdict`
   - Audit path: `~/.zana/checkpoints/<deliberationId>.json`

## Rules

- The override is symmetric with a voter vote — auditable, content-addressed. Do not paraphrase the reason; pass it through verbatim.
- Do NOT call any tool other than the two listed in `allowed-tools`.
- If the user's `<reason>` is shorter than ~10 characters, ask them to expand it before recording — overrides without substantive reasoning are an anti-pattern.
