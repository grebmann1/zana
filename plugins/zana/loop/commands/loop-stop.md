---
name: zana:loop:stop
description: Stop one or all Zana /loop schedules armed by /zana:loop:start. Kills the matching background sleeper processes.
argument-hint: "[scheduleId]"
allowed-tools: Bash
---

# /zana:loop:stop

Stop running `/loop` schedules that were armed by `/zana:loop:start`. Each loop is identified by a sentinel of the form `AGENT_LOOP_TICK_zana_<id>`.

`$ARGUMENTS` is optional: a single schedule id stops only that one; empty stops all zana-armed loops.

## Workflow

1. **Parse** `$ARGUMENTS`. If non-empty, the grep pattern is `AGENT_LOOP_TICK_zana_<id>`. Otherwise it's `AGENT_LOOP_TICK_zana_`.
2. **Find PIDs** — `Bash` `ps -ef | grep "<pattern>" | grep -v grep`. Capture PID column.
3. **Empty case** — if no matching processes, tell the user no zana loops are running and stop.
4. **Announce intent** — `Stopping N zana loop(s): <ids>.` (Extract ids from each command's sentinel suffix.)
5. **Kill** — `Bash` `kill <pid1> <pid2> ...` for all matched PIDs.
6. **Verify** — re-run the same `ps | grep` to confirm. If any survive, escalate with `kill -9 <surviving pids>` and warn the user.
7. **Confirm** — list which schedule ids were stopped. Note that the loops will not re-arm (they're not persistent across Claude Code sessions either — but explicit kill is cleaner).

## Rules

- Mutating call — always announce intent before killing.
- Match only sentinels with the `zana_` prefix. Never kill arbitrary `AGENT_LOOP_TICK_*` loops the user armed manually.
- If `$ARGUMENTS` names an id that has no matching process, say so plainly. Don't fall through to killing all.
- Use `kill <pid>` (SIGTERM) first; only use `kill -9` if a process survives the first attempt.
