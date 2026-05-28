---
name: zana-scheduler
description: Use when authoring or driving Zana scheduler YAML files at .zana/scheduler/*.yml — covers the file schema, the daemon vs /loop execution paths, and how each yml maps to a /loop invocation. Triggered by /zana:loop:start, /zana:loop:stop, /zana:loop:define, or any user request mentioning .zana/scheduler files.
---

# Zana Scheduler — schema + rules

A Zana schedule is a small YAML file under `<workspace>/.zana/scheduler/`. The same file can be driven two ways:

- **Daemon path (heavyweight)** — the Zana daemon reads the file, registers a cron/interval trigger, and executes it. Surfaced via `/zana:schedule:list`, `/zana:schedule:reload`, `/zana:schedule:trigger`. Supports `cron:` schedules and `spawn-agent` actions with full profile support.
- **`/loop` path (lightweight)** — Claude Code reads the file and arms a `/loop` directly in the shell, no daemon needed. Surfaced via `/zana:loop:start`, `/zana:loop:stop`, `/zana:loop:define`. Supports `every:` schedules only.

The yml file is a portable contract — one file works for both paths.

## File location

- Active schedules: `<workspace>/.zana/scheduler/*.yml`
- Examples: `<workspace>/.zana/scheduler/examples/*.yml.example`
- Run history (daemon-managed): `<workspace>/.zana/scheduler/<id>.history.json` — never edit by hand.

The filename stem must match the `id:` field (e.g. `code-and-docs-audit.yml` ↔ `id: code-and-docs-audit`).

## Schema

```yaml
id: <kebab-case-slug>            # required; matches filename stem
name: <human-readable name>      # required
description: |                   # required; multi-line ok
  What this schedule does and why.
enabled: true                    # required; false = parked

schedule:                        # required; pick exactly one of:
  every: 10m                     #   interval: 30s, 5m, 1h, 2d, 500ms (preferred for /loop)
  # cron: "0 2 * * *"            #   cron: standard 5-field expr, host TZ (daemon only)
  # intervalMs: 600000           #   raw ms — accepted but `every:` is friendlier

action:                          # required; pick exactly one type:
  type: spawn-agent              #  (a) spawn an agent
  profileId: code-reviewer       #      profile id from `/zana` profile list
  prompt: |                      #      multi-line prompt for the agent
    Do thing X. Report Y.

  # type: command                #  (b) run a shell command
  # command: ["npm", "run", "build:runtime"]   # ARRAY only — no shell strings
  # cwd: .                       #      working dir, default = workspace root

history:                         # optional; daemon-only
  enabled: true                  # default true
  retain: 24                     # how many past runs to keep in <id>.history.json
```

### Daemon-managed fields — DO NOT author these

The daemon writes these on every run. They will be overwritten. Strip them when authoring a new file.

```yaml
updatedAt: 2026-05-28T19:22:19.569Z
status:
  nextRunAt: 2026-05-28T19:57:30.160Z
  lastRunAt: 2026-05-28T19:22:19.564Z
  lastRunResult: success
  runCount: 1245
```

## Translation to `/loop` (lightweight path)

When `/zana:loop:start` arms a schedule, it converts the yml into a `/loop` invocation as follows:

| yml `schedule`      | yml `action.type`  | `/loop` invocation                                         |
|---------------------|--------------------|------------------------------------------------------------|
| `every: 10m`        | `command`          | `/loop 10m <command joined with spaces>` in `cwd`          |
| `every: 10m`        | `spawn-agent`      | `/loop 10m <prompt>` (loop body becomes the prompt)        |
| `cron: …`           | *(any)*            | NOT supported — refuse and point user at the daemon path   |
| `intervalMs: N`     | *(any)*            | translate to `every:` (e.g. `600000` → `10m`)              |

Sentinel naming convention used by `/zana:loop:start`: `AGENT_LOOP_TICK_zana_<id>`. `/zana:loop:stop` finds running loops by grepping for this prefix.

## Authoring rules

When writing a new yml file (used by `/zana:loop:define`):

1. Pick a kebab-case `id` — must match the filename stem.
2. Prefer `every:` over `cron:` unless the user truly needs wall-clock scheduling — `every:` works for both daemon and `/loop` paths; `cron:` is daemon-only.
3. For `command` actions, the `command:` field MUST be an array. Shell strings are rejected for safety. If the user wants pipes/redirects, wrap in `["sh","-c","cmd | other"]`.
4. For `spawn-agent` actions, `profileId` must be one that exists — list with `mcp__zana__zana_list_profiles` if unsure.
5. Do NOT include `status:` or `updatedAt:` blocks — the daemon writes them on first run.
6. Set `enabled: true` if you want it to run; `false` parks it without deletion.
7. Pick `history.retain` low (≤24) for high-frequency schedules (every ≤1m) so `<id>.history.json` doesn't bloat.

## Existing examples (read for templates)

- `.zana/scheduler/code-and-docs-audit.yml` — real-world `spawn-agent` + `every: 10m`
- `.zana/scheduler/examples/daily-test-audit.yml.example` — `cron:` + `spawn-agent`
- `.zana/scheduler/examples/hourly-build-health.yml.example` — `every:` + `command` (with `history`)
- `.zana/scheduler/examples/weekly-security-scan.yml.example` — `cron:` + `spawn-agent`
