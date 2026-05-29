# Zana QA — terminal-command verification

Scenario specs (authored by Phase A QA team) live under `scenarios/`.

## How to run

Phase B testers walk the markdown specs directly:

```bash
# clean slate
rm -rf /tmp/zana-qa-* && node dist/bin/zana.js stop --all 2>/dev/null

# fast: CLI + MCP
bash scripts/qa/run-fast.sh   # produces results/cli.txt + results/mcp.txt

# slow: daemon + plugin lifecycle (touches ~/.zana/)
bash scripts/qa/run-slow.sh   # produces results/daemon.txt
```

Each results file is a flat list:

```
S1   PASS  zana --help
S2   PASS  zana init creates .zana/
...
S99  FAIL  <reason>
```

Aggregate summary printed at end: `100% PASS (N scenarios, M deferred)`.

## Pass-rate target

100%. Failures must be fixed and the failing scenario re-run before the
suite is considered green.

## Live-Claude-Code scripts

These exercise real agent dispatch — they spawn the local `claude` CLI as
the worker and round-trip through the daemon. Whatever auth `claude` itself
uses (Claude Code subscription, API key, etc.) is the auth Zana inherits.
No `ANTHROPIC_API_KEY` is required.

```bash
# All five in sequence
bash scripts/qa/run-live-all.sh

# Or individually:
bash scripts/qa/run-runtime.sh                # R1 spawn oneshot, R2 deliberation snap
bash scripts/qa/run-scheduler-agent-live.sh   # schedule fires spawn-agent → real worker → history
bash scripts/qa/run-ticket-live.sh            # ticket create → claim → spawn worker → complete
bash scripts/qa/run-autopilot-live.sh         # goal-driven autopilot, one cycle, then cancel
bash scripts/qa/run-judge-live.sh             # auto-judge: cap_exhausted → judge, high-risk bypass, hybrid
```

Each script gates on `claude` being on PATH; without it prints `SKIP all`
and exits 0.

## Deferred (legacy spec)

See `scenarios/runtime-deferred.md` — the original markdown specs that
preceded the runner scripts above.
