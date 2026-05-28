---
name: zana:loop:start
description: Arm a Claude Code /loop for one (or all enabled) Zana scheduler YAML files. Lightweight alternative to the daemon path.
argument-hint: "[scheduleId]"
allowed-tools: Bash, Read, Glob, AskUserQuestion, Skill
---

# /zana:loop:start

Read `.zana/scheduler/*.yml` files and arm a `/loop` for one or more of them. No daemon required.

`$ARGUMENTS` is optional: a single schedule id targets only that schedule; empty prompts the user to pick.

For the yml schema and translation rules, defer to the `zana-scheduler` skill (`plugins/zana/loop/skills/scheduler/SKILL.md`). Read it on first use to refresh on the rules.

## Workflow

1. **Parse** `$ARGUMENTS`. If non-empty, treat as a target schedule id and skip the picker.
2. **List** `.zana/scheduler/*.yml` via `Glob` against `<workspace>/.zana/scheduler/*.yml`. Exclude `*.example` (lives under `examples/`) and `*.history.json`.
3. **Empty case** — if zero yml files, tell user and suggest `/zana:loop:define` to create one. Stop.
4. **Read** each candidate file with `Read`. Extract: `id`, `name`, `enabled`, `schedule.{every,cron,intervalMs}`, `action.{type,command,cwd,prompt,profileId}`.
5. **Pick target schedule(s)**:
   - If `$ARGUMENTS` named one, use it. If not found, list available ids and stop.
   - Otherwise, render a one-line summary per schedule (`id`, `enabled`, trigger, action.type) and call `AskUserQuestion` with up to 4 candidates plus an "All enabled" option. If more than 4 schedules exist, list them in plain text and ask the user to re-invoke with an id.
6. **Validate** each chosen schedule:
   - `enabled: false` → refuse, suggest editing the file or `/zana:loop:define` to flip it.
   - `cron:` set (no `every:`) → refuse — `/loop` doesn't do wall-clock cron. Point user at `/zana:schedule:reload` (daemon path).
   - `action.type` not in `{command, spawn-agent}` → refuse.
   - `command` action with `command:` not an array → refuse.
7. **Translate** to a `/loop` invocation per the table in the `zana-scheduler` skill:
   - `command` action → `/loop <every> <command joined with spaces>` (run in `cwd` if set, otherwise workspace root).
   - `spawn-agent` action → `/loop <every> <prompt>` — the prompt body becomes the loop body. Note the `profileId` in the loop title for context.
   - `intervalMs: N` → convert to a human unit (e.g. `600000` → `10m`).
8. **Check for duplicates** — `Bash` `ps -ef | grep "AGENT_LOOP_TICK_zana_<id>" | grep -v grep`. If a row comes back, tell the user the loop is already armed and stop (suggest `/zana:loop:stop <id>` first).
9. **Announce intent** — one line per loop: `Arming /loop for <id> every <every> (<action.type>).` Then **invoke the `loop` skill** with the translated arguments. The `loop` skill owns the bash `while/sleep/echo` template, sentinel naming, and the immediate first run — do not hand-roll it. Pass a sentinel suffix of `zana_<id>` so `/zana:loop:stop` can find it.
10. **Confirm** to the user: schedule id, interval, that the prompt/command already ran once, when the next tick fires, and that `/zana:loop:stop <id>` will halt it.

## Rules

- Read-only against the yml files — never edit them from this command. Use `/zana:loop:define` to author/modify.
- Refuse `cron:` schedules; they're daemon-only. Don't try to translate cron to `every:`.
- Always announce intent before arming a loop (mutating action — starts a background process).
- One `/loop` per schedule id. Never arm two loops with the same sentinel.
- If `$ARGUMENTS` names an unknown id, list the available ids and stop. Don't fall through to the picker.
