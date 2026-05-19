# @zana/work

Work-tracking domains: tickets, scheduling, teams, runs.

## Scheduler — YAML schema contract

Schedules are YAML files under `.zana/scheduler/<id>.yml`. The contract
below is enforced by `validateSchedule()` in `scheduling/schema.ts`. Fields
not listed are **ignored** (and produce a warning at load time).

### Top-level fields

| Field         | Required | Type    | Notes |
|---------------|----------|---------|-------|
| `id`          | yes      | string  | Stable ID. Filename = `<id>.yml`. |
| `name`        | yes      | string  | Human label. |
| `description` | no       | string  | Free-form. |
| `enabled`     | no       | bool    | Default `true`. Disabled schedules are kept on disk but no trigger is started. |
| `schedule`    | yes\*    | object  | Trigger block — see below. \*Optional only when `enabled: false` (manual-trigger only). |
| `action`      | yes      | object  | What to run — see below. |
| `history`     | no       | object  | Run-history retention — see below. Default: enabled, retain 10. |
| `ownerId`     | no       | string  | Optional creator metadata. |
| `ownerName`   | no       | string  | Optional creator metadata. |

### Daemon-managed fields (do not edit by hand)

These are written back on every run and any user value is overwritten:

- `createdAt`, `updatedAt`
- `status` (object: `lastRunAt`, `lastRunResult`, `nextRunAt`, `runCount`)
- legacy flat aliases: `lastRunAt`, `lastRunResult`, `nextRunAt`, `runCount`

### `schedule.*` block

Provide **at least one** of:

| Field        | Type    | Example       | Notes |
|--------------|---------|---------------|-------|
| `cron`       | string  | `"0 2 * * *"` | Standard 5-field cron, host TZ. |
| `every`      | string  | `"5m"`, `"2h"`, `"30s"`, `"500ms"`, `"1d"` | Shorthand. Compiled to `intervalMs`. |
| `intervalMs` | integer | `120000`      | Raw milliseconds. Wins over `every` if both set. |

If `cron` is present it takes precedence over interval-based fields.

### `action.*` block

`action.type` must be one of:

| Type           | Required fields | Notes |
|----------------|-----------------|-------|
| `spawn-agent`  | `profileId`, `prompt` | Spawn a headless agent from a profile. `cwd` optional (defaults to workspace root). |
| `prompt`       | (alias of `spawn-agent`) | |
| `team`         | `teamId`, `prompt` | Start a saved team with the given prompt. |
| `command`      | `command` *(or `argv`)* — array of strings | `execFile`-based. **Shell strings are rejected** as a security measure. Example: `["npm", "run", "build"]`. |
| `workflow`     | (not yet wired) | Placeholder. |
| `mcp_tool`     | (not yet wired) | Placeholder. |

### `history.*` block (opt-in retention controls)

```yaml
history:
  enabled: true   # default; set false to disable run-history persistence
  retain: 10      # default; max kept entries (0 = none, max 1000)
```

When `enabled: false`:
- No `<id>.history.json` file is written
- `getRunHistory()` returns `[]`
- spawn-agent post-termination summary patches are skipped

When `retain` is a positive integer, the history file is a fixed-size ring
of the most recent N entries.

### Validation behaviour

`validateSchedule(raw)` returns a list of `{level, field, message}` issues:

- `error` — schedule is **rejected** by `createSchedule` / `updateSchedule`
- `warning` — schedule is accepted but a console warning is emitted

Warnings cover unknown top-level fields and unknown `schedule.*` keys —
useful for catching typos like `interval_ms:` (snake-case, not supported).

### Example: minimal cron schedule

```yaml
id: nightly-build
name: Nightly build
enabled: true
schedule:
  cron: "0 2 * * *"
action:
  type: command
  command: ["npm", "run", "build"]
history:
  enabled: true
  retain: 30
```

### Example: short-interval, no history (lightweight notify)

```yaml
id: heartbeat
name: 30-sec heartbeat
enabled: true
schedule:
  every: 30s
action:
  type: command
  command: ["true"]
history:
  enabled: false
```
