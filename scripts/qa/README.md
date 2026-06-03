# Zana QA — terminal-command verification

Scenario specs (authored by Phase A QA team) live under `scenarios/`.

## Live-Claude-Code scripts

These exercise real agent dispatch — they spawn the local `claude` CLI as
the worker and round-trip through the daemon. Whatever auth `claude` itself
uses (Claude Code subscription, API key, etc.) is the auth Zana inherits.
No `ANTHROPIC_API_KEY` is required.

```bash
# All six in sequence
bash scripts/qa/run-live-all.sh

# Or individually:
bash scripts/qa/run-runtime.sh                # R1 spawn oneshot, R2 deliberation snap
bash scripts/qa/run-scheduler-agent-live.sh   # schedule fires spawn-agent → real worker → history
bash scripts/qa/run-ticket-live.sh            # ticket create → claim → spawn worker → complete
bash scripts/qa/run-autopilot-live.sh         # goal-driven autopilot, one cycle, then cancel
bash scripts/qa/run-judge-live.sh             # auto-judge: cap_exhausted → judge, high-risk bypass, hybrid
bash scripts/qa/run-commands-live.sh          # every slash command's underlying MCP tool, via real stdio transport
```

Each script gates on `claude` being on PATH; without it prints `SKIP all`
and exits 0.

## Deferred (legacy spec)

See `scenarios/runtime-deferred.md` — the original markdown specs that
preceded the runner scripts above.
