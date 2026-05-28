---
name: zana:loop:define
description: Author a new Zana scheduler YAML file under .zana/scheduler/ by walking the user through the schema. The file works with both /zana:loop:start and the daemon path.
argument-hint: "[scheduleId]"
allowed-tools: Read, Glob, Write, AskUserQuestion, Skill
---

# /zana:loop:define

Guide the user through creating a new `.zana/scheduler/<id>.yml` file. Inspect existing files for templates rather than embedding one.

`$ARGUMENTS` is optional: a kebab-case id slug for the new schedule. Empty prompts the user.

For the yml schema, defer to the `zana-scheduler` skill (`plugins/zana/loop/skills/scheduler/SKILL.md`). Read it on first use to refresh the rules.

## Workflow

1. **Read schema doc** — `Read` `plugins/zana/loop/skills/scheduler/SKILL.md` so the rules are current.
2. **Decide id** — if `$ARGUMENTS` looks like a kebab-case slug, use it. Otherwise ask the user for a one-line description of what they want scheduled, derive a kebab-case id, and confirm it before continuing.
3. **Refuse if exists** — `Glob` `<workspace>/.zana/scheduler/<id>.yml`. If it exists, refuse and suggest editing it directly or picking another id.
4. **Survey templates** — `Glob` `<workspace>/.zana/scheduler/*.yml` and `<workspace>/.zana/scheduler/examples/*.yml.example`. `Read` 2-3 closest matches based on what the user described. Use them to inform field choices, not to copy-paste verbatim.
5. **Pin down the schedule** with `AskUserQuestion`:
   - **Cadence** — options: "every Ns/m/h" (recommend `every:` since it works for both `/loop` and daemon paths), or "cron expression" (daemon-only — warn the user `/zana:loop:start` will refuse it).
   - **Action type** — options: `command` (run a shell command) or `spawn-agent` (spawn a Zana profile).
6. **Gather action details** based on the answer:
   - `command` — ask for the command as a JSON-style array (`["bin","arg1",...]`) and an optional `cwd`. Reject shell strings; if the user wants pipes, wrap as `["sh","-c","..."]`.
   - `spawn-agent` — ask for `profileId` and the prompt. Suggest checking `mcp__zana__zana_list_profiles` if the id is unclear.
7. **Compose** the yml in memory. Required: `id`, `name`, `description`, `enabled: true`, exactly one of `schedule.{every,cron}`, and a valid `action`. Do NOT include `status:` or `updatedAt:` — the daemon writes those on first run.
8. **Confirm** — show the user the full yml content and the target path (`<workspace>/.zana/scheduler/<id>.yml`). Wait for explicit confirmation before writing.
9. **Write** the file with `Write`.
10. **Suggest next step**:
    - If `every:`, suggest `/zana:loop:start <id>` for the lightweight path or `/zana:schedule:reload` for the daemon path.
    - If `cron:`, suggest `/zana:schedule:reload` only.

## Rules

- This is the only command in the loop plugin that writes files. Always confirm the full content with the user before calling `Write`.
- The filename stem MUST equal the `id:` field. Reject mismatches.
- Reject `cron:` + `command:` shell-string combinations. The `command:` field is always an array.
- Don't include `status:` or `updatedAt:` blocks. The daemon manages those.
- If the user names a `profileId` that you can't verify exists, write the file but warn them to check with `mcp__zana__zana_list_profiles` before arming.
- Do not edit existing yml files from this command — refuse and suggest direct edit.
