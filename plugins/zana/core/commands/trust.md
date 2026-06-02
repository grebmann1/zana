---
name: zana:trust
description: Pre-approve every Zana MCP tool in this project so Claude Code stops prompting per-call.
allowed-tools: Read Edit Write Bash
---

# /zana:trust

Adds wildcard pre-approvals for every `mcp__zana__zana_*` tool to the
project-local `.claude/settings.local.json` so Claude Code stops asking you to
approve each call individually. Scoped to the current project only — does
not touch your global `~/.claude/settings.json`.

This command takes no arguments. Idempotent: safe to re-run.

## Workflow

1. Resolve the target file: `<cwd>/.claude/settings.local.json`. Create the
   `.claude/` directory if it does not exist (it's already gitignored in most
   project templates; do NOT add it to `.gitignore` — leave that to the user).

2. Read the file if present, otherwise start from `{}`.

3. Ensure the shape `{ "permissions": { "allow": [...] } }` exists. Merge in
   the Zana wildcards below WITHOUT removing anything the user already has:

   ```
   mcp__zana__*
   ```

   Use a wildcard, not the 70-tool literal list — the surface keeps growing
   and a wildcard is the only sustainable approval. If the user wants a
   tighter scope, they can hand-edit afterward.

4. Write the file back with `JSON.stringify(obj, null, 2) + "\n"`.

5. Print a one-line confirmation:
   `pre-approved mcp__zana__* in .claude/settings.local.json — restart this Claude Code session for it to take effect`

   (Permission settings are read at session start; the user must `/clear` or
   restart for the change to apply mid-session.)

## Rules

- Project-scoped only. Never edit `~/.claude/settings.json` from this command.
- Never add `defaultMode: "bypassPermissions"` — that's a global escape hatch
  the user should opt into deliberately, not via a slash command.
- If `.claude/settings.local.json` already contains `mcp__zana__*` in
  `permissions.allow`, say `already trusted` and exit without writing.
- Preserve any keys the file already had — this is a merge, not an overwrite.
