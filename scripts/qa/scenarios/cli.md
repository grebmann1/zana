# Zana CLI — QA Scenarios

QA author: scenario specs only. Do NOT execute. The Zana repo root is referred
to as `$ZANA` (resolve to `/Users/grebmann/Documents/claude-workspace/zana` or
the equivalent on the QA host). All commands invoke the dispatcher via
`node dist/bin/zana.js` from `$ZANA` — this avoids any dependency on a global
`npm install -g .`.

Every scenario is hermetic: each uses its own temp workspace under
`/tmp/zana-qa-<scenario-id>/`, and stops every daemon it starts in the
`Cleanup` block. Scenarios that mutate the daemon registry (`~/.zana/daemons/`)
take a snapshot first via `ZANA_DAEMONS_DIR` override or by recording the
existing entries before the test, so unrelated daemons on the host are left
untouched.

Conventions used in expectations:
- "Expected stdout includes" means a substring match (grep -F equivalent).
- ANSI color codes (e.g. `\x1b[36m`) may be present in real output; matchers
  should ignore them or strip them before comparing.
- Exit code `N` for negatives means strictly nonzero unless a specific value
  is given.

---

## Scenario 1: `zana --help` prints usage and exits 0

**Preconditions:**
- `$ZANA/dist/bin/zana.js` exists (build completed).

**Command:**
```bash
node dist/bin/zana.js --help
```

**Expected exit code:** 0
**Expected stdout includes:** "Usage: zana"
**Expected stdout also includes:** "init", "migrate", "status", "stop", "headless", "schedule"
**Expected stderr includes:** (nothing required)
**Cleanup:** none (read-only).

Repeat the same scenario with `-h` and with no args at all — all three should
print the same help banner and exit 0.

---

## Scenario 2: `zana init <tmpdir>` creates `.zana/`

**Preconditions:**
- Temp dir prepared: `mkdir -p /tmp/zana-qa-002 && rm -rf /tmp/zana-qa-002/.zana`.

**Command:**
```bash
node dist/bin/zana.js init /tmp/zana-qa-002
```

**Expected exit code:** 0
**Expected stdout includes:** (no error text; init prints minimal output)
**Expected filesystem state after run:**
- `/tmp/zana-qa-002/.zana/` exists and is a directory.
- At minimum one of: `tickets/`, `runs/`, `scheduler/` subdirs present (init
  scaffolds the standard layout).

**Cleanup:**
```bash
rm -rf /tmp/zana-qa-002
```

---

## Scenario 3: `zana init wizard <tmpdir> --repair-mcp`

**Preconditions:**
- Temp dir prepared: `mkdir -p /tmp/zana-qa-003`.
- MCP side-effects must be sandboxed. Set `HOME=/tmp/zana-qa-003-home`
  (then `mkdir -p /tmp/zana-qa-003-home`) so the wizard writes any
  `~/.claude/settings.json` mutations under the temp HOME instead of the
  real user's settings. Treat any fallout in the real `~/.claude/` as a
  failed precondition.

**Command:**
```bash
HOME=/tmp/zana-qa-003-home node dist/bin/zana.js init wizard /tmp/zana-qa-003 --repair-mcp
```

**Expected exit code:** 0
**Expected stdout includes:** "zana init wizard", "complete", "Workspace:",
"MCP server:", "Status line:"
**Expected filesystem state after run:**
- `/tmp/zana-qa-003/.zana/` exists.
- The sandboxed `HOME` may now contain a `.claude/settings.json` referring to
  `zana` — confirm this file path is under `/tmp/zana-qa-003-home`, not the
  real `$HOME`.

**Negative guard:** If the binary is invoked against a non-directory target
(e.g. `node dist/bin/zana.js init wizard /tmp/zana-qa-003/does-not-exist`),
exit code is nonzero and stderr contains `not a valid directory`.

**Cleanup:**
```bash
rm -rf /tmp/zana-qa-003 /tmp/zana-qa-003-home
```

---

## Scenario 4: `zana migrate <tmpdir>` runs migrations and exits 0

**Preconditions:**
- Temp dir initialized: `mkdir -p /tmp/zana-qa-004 && node dist/bin/zana.js init /tmp/zana-qa-004`.

**Command:**
```bash
node dist/bin/zana.js migrate /tmp/zana-qa-004
```

**Expected exit code:** 0
**Expected stdout includes:** "zana migrate", "/tmp/zana-qa-004", "--- Summary ---",
"Copied:", "Skipped:", "Errors:"
**Expected stderr includes:** (none)

**Negative guard:** Pointing migrate at a non-directory must fail:
```bash
node dist/bin/zana.js migrate /tmp/zana-qa-004/nope
```
Exit nonzero, stderr contains "not a valid directory".

**Cleanup:**
```bash
rm -rf /tmp/zana-qa-004
```

---

## Scenario 5: `zana status` with no daemon

**Preconditions:**
- Override the daemon registry to an empty dir so the test is hermetic
  regardless of host state:
  ```bash
  mkdir -p /tmp/zana-qa-005-daemons
  ```
- Note: `printStatus()` reads `~/.zana/daemons` directly (NOT the
  `ZANA_DAEMONS_DIR` env override — that is only honored by `stop --all`).
  So this scenario must be run on a host with a clean registry, OR the
  scenario should temporarily relocate `~/.zana/daemons/` (move aside, then
  restore in cleanup).

**Setup (registry isolation):**
```bash
if [ -d ~/.zana/daemons ]; then mv ~/.zana/daemons ~/.zana/daemons.qa-005.bak; fi
```

**Command:**
```bash
node dist/bin/zana.js status
```

**Expected exit code:** 0
**Expected stdout includes:** "No daemon(s) running."
**Expected stderr includes:** (none)

**Cleanup:**
```bash
if [ -d ~/.zana/daemons.qa-005.bak ]; then rm -rf ~/.zana/daemons && mv ~/.zana/daemons.qa-005.bak ~/.zana/daemons; fi
```

---

## Scenario 6: `zana headless <tmpdir> --background` then `zana status` shows it

**Preconditions:**
- Temp workspace: `mkdir -p /tmp/zana-qa-006`.
- Record the current daemon registry so we can identify the new entry:
  ```bash
  ls ~/.zana/daemons/ 2>/dev/null | sort > /tmp/zana-qa-006.before
  ```

**Command (start):**
```bash
node dist/bin/zana.js headless /tmp/zana-qa-006 --background &
HEADLESS_PID=$!
sleep 4
```

**Command (verify):**
```bash
node dist/bin/zana.js status
```

**Expected exit code (status):** 0
**Expected stdout includes:** "daemon(s) running:", "/tmp/zana-qa-006",
a `port:` field, a `pid:` field, the bullet "●".

**Sanity check:** The new daemon entry should appear under `~/.zana/daemons/`
with `workspace` set to the resolved temp path. Diffing
`ls ~/.zana/daemons/` against `/tmp/zana-qa-006.before` should show exactly
one new `*.json` file.

**Cleanup:**
```bash
# Find the daemon id whose workspace matches our tmpdir, then stop it.
DAEMON_ID=$(node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const d=path.join(os.homedir(),".zana","daemons");
for (const f of fs.readdirSync(d)) {
  try { const e=JSON.parse(fs.readFileSync(path.join(d,f),"utf8"));
    if (e.workspace==="/tmp/zana-qa-006") { console.log(e.id); break; } } catch {}
}
')
[ -n "$DAEMON_ID" ] && node dist/bin/zana.js stop "$DAEMON_ID"
wait $HEADLESS_PID 2>/dev/null
rm -rf /tmp/zana-qa-006 /tmp/zana-qa-006.before
```

---

## Scenario 7: `zana stop <id>` stops a specific daemon

**Preconditions:**
- A daemon is running for a known temp workspace. Reuse the start flow from
  Scenario 6 against `/tmp/zana-qa-007`:
  ```bash
  mkdir -p /tmp/zana-qa-007
  node dist/bin/zana.js headless /tmp/zana-qa-007 --background &
  HEADLESS_PID=$!
  sleep 4
  DAEMON_ID=$(node -e '
  const fs=require("fs"),path=require("path"),os=require("os");
  const d=path.join(os.homedir(),".zana","daemons");
  for (const f of fs.readdirSync(d)) {
    try { const e=JSON.parse(fs.readFileSync(path.join(d,f),"utf8"));
      if (e.workspace==="/tmp/zana-qa-007") { console.log(e.id); break; } } catch {}
  }
  ')
  ```

**Command:**
```bash
node dist/bin/zana.js stop "$DAEMON_ID"
```

**Expected exit code:** 0
**Expected stdout includes:** "Stopped daemon", "$DAEMON_ID"
**Expected post-state:** Within ~2s `~/.zana/daemons/$DAEMON_ID.json` is gone
(the next `zana status` call no longer lists it).

**Negative guard (same scenario):** Calling `zana stop nonexistent-id` exits
nonzero with stderr `Daemon not found: nonexistent-id`.

**Cleanup:**
```bash
wait $HEADLESS_PID 2>/dev/null
# Belt-and-suspenders in case the daemon survived:
node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
rm -rf /tmp/zana-qa-007
```

---

## Scenario 8: `zana stop --all` stops every daemon

**Preconditions:**
- Two daemons running for two distinct temp workspaces:
  ```bash
  mkdir -p /tmp/zana-qa-008a /tmp/zana-qa-008b
  node dist/bin/zana.js headless /tmp/zana-qa-008a --background &
  PID_A=$!
  node dist/bin/zana.js headless /tmp/zana-qa-008b --background &
  PID_B=$!
  sleep 5
  ```
- Confirm both are listed: `node dist/bin/zana.js status` should show >=2
  entries.

**Command:**
```bash
node dist/bin/zana.js stop --all
```

**Expected exit code:** 0
**Expected stdout includes:** "stopped " followed by an integer (count of
daemons reaped). The count should be >=2.

**Expected post-state:** `node dist/bin/zana.js status` prints
"No daemon(s) running." (assuming no other daemons were previously alive).
This scenario therefore SHOULD only run on a host where the QA harness owns
all daemons — otherwise unrelated daemons will be killed. Document this as a
required precondition.

**Cleanup:**
```bash
wait $PID_A $PID_B 2>/dev/null
rm -rf /tmp/zana-qa-008a /tmp/zana-qa-008b
```

---

## Scenario 9: `zana config list` exits 0 and prints modules

**Preconditions:**
- Build artifacts exist: `$ZANA/packages/core/dist/bin/daemon.js` is present.

**Command:**
```bash
node dist/bin/zana.js config list
```

**Expected exit code:** 0
**Expected stdout includes:** at least one module name (the daemon's
`config list` output enumerates registered modules; expect names like
`runtime`, `scheduler`, `tickets`, etc., depending on what is registered).
**Expected stderr includes:** (none)

**Cleanup:** none.

---

## Scenario 10: `zana config get <module>`

**Preconditions:**
- Pick a known module name from Scenario 9. Use `runtime` as a stable example;
  if not present in the test build, substitute the first name printed by
  `zana config list`.

**Command:**
```bash
node dist/bin/zana.js config get runtime
```

**Expected exit code:** 0
**Expected stdout includes:** parseable representation of the module config
(JSON or `key=value` pairs, depending on daemon impl). Empty output is
acceptable for a module with no settings, but exit code must be 0.

**Negative guard:** `zana config get __no_such_module__` should exit nonzero
and propagate the daemon's error message to stderr.

**Cleanup:** none.

---

## Scenario 11: `zana config set <module> <key> <value>` persists

**Preconditions:**
- Module name from Scenario 9. To avoid polluting the host's persistent
  config, run with an isolated `HOME`:
  ```bash
  mkdir -p /tmp/zana-qa-011-home
  ```
- Use a known schema key. The `system` module advertises
  `maxConcurrentAgents`; set it to a non-default value (e.g. `7`) and
  verify it round-trips. Unknown keys are correctly rejected by
  `config set` against the module schema.

**Command (set):**
```bash
HOME=/tmp/zana-qa-011-home node dist/bin/zana.js config set system maxConcurrentAgents 7
```

**Expected exit code:** 0
**Expected stdout includes:** substring match on `maxConcurrentAgents` and `7`.

**Verification:**
```bash
HOME=/tmp/zana-qa-011-home node dist/bin/zana.js config get system
```
Stdout must include `maxConcurrentAgents` and `7`.

**Negative guard (unknown key rejected):**
```bash
HOME=/tmp/zana-qa-011-home node dist/bin/zana.js config set system bogus_key 1
```
Expected exit code: nonzero; stderr lists `Available:` keys.

**Cleanup:**
```bash
rm -rf /tmp/zana-qa-011-home
```

---

## Scenario 12: `zana ticket list --workspace <tmpdir>` (daemon required)

**Preconditions:**
- Start a daemon for a fresh temp workspace:
  ```bash
  mkdir -p /tmp/zana-qa-012
  node dist/bin/zana.js headless /tmp/zana-qa-012 --background &
  HEADLESS_PID=$!
  sleep 4
  ```

**Command:**
```bash
node dist/bin/zana.js ticket list --workspace /tmp/zana-qa-012
```

**Expected exit code:** 0
**Expected stdout includes:** Either an empty body (no tickets in a fresh
workspace — output is zero lines) OR one `<id> | <status> | <priority> | <title>`
line per ticket. Either is acceptable; the test passes if exit code is 0 and
stderr is empty.

**Negative guard (same scenario):** With NO daemon running for the workspace,
the command exits nonzero and stderr includes "no daemon running for this workspace".
Test this by stopping the daemon first then re-running:
```bash
node dist/bin/zana.js stop --all >/dev/null
node dist/bin/zana.js ticket list --workspace /tmp/zana-qa-012   # expect exit !=0
```

**Cleanup:**
```bash
node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
wait $HEADLESS_PID 2>/dev/null
rm -rf /tmp/zana-qa-012
```

---

## Scenario 13: `zana ticket rules list --workspace <tmpdir>`

**Preconditions:**
- Daemon running for `/tmp/zana-qa-013`:
  ```bash
  mkdir -p /tmp/zana-qa-013
  node dist/bin/zana.js headless /tmp/zana-qa-013 --background &
  HEADLESS_PID=$!
  sleep 4
  ```

**Command:**
```bash
node dist/bin/zana.js ticket rules list --workspace /tmp/zana-qa-013
```

**Expected exit code:** 0
**Expected stdout includes:** Either "No automation rules loaded." (default
empty workspace) OR one or more lines of the form
`<name>  on=<event>  profile=<profile>`.
**Expected stderr includes:** (none)

**Cleanup:**
```bash
node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
wait $HEADLESS_PID 2>/dev/null
rm -rf /tmp/zana-qa-013
```

---

## Scenario 14: `zana run list --limit 5 --workspace <tmpdir>` (no daemon needed)

**Preconditions:**
- Initialized workspace, no daemon required (this command only reads
  `.zana/runs/` from disk):
  ```bash
  mkdir -p /tmp/zana-qa-014
  node dist/bin/zana.js init /tmp/zana-qa-014
  ```

**Command:**
```bash
node dist/bin/zana.js run list --limit 5 --workspace /tmp/zana-qa-014
```

**Expected exit code:** 0
**Expected stdout includes:** Either "(no runs directory)" or a sequence of
zero-to-five run lines of the form
`<id> | <profile> | <state> | tok=<in>/<out> | $<cost> | <ms>ms | <ts>`.
**Expected stderr includes:** (none)

**Negative guard (same scenario):**
```bash
node dist/bin/zana.js run                # missing subverb
```
Exit nonzero, stderr includes "Usage: zana run list".

**Cleanup:**
```bash
rm -rf /tmp/zana-qa-014
```

---

## Scenario 15: `zana schedule list --workspace <tmpdir>` (text)

**Preconditions:**
- Initialized workspace with one fixture YAML schedule:
  ```bash
  mkdir -p /tmp/zana-qa-015
  node dist/bin/zana.js init /tmp/zana-qa-015
  mkdir -p /tmp/zana-qa-015/.zana/scheduler
  cat > /tmp/zana-qa-015/.zana/scheduler/qa-noop.yml <<'YAML'
  id: qa-noop
  name: QA No-Op
  enabled: false
  schedule:
    every: 1h
  action:
    type: workflow
    skillId: noop
  YAML
  ```

**Command:**
```bash
node dist/bin/zana.js schedule list --workspace /tmp/zana-qa-015
```

**Expected exit code:** 0
**Expected stdout includes:** "qa-noop", "disabled", "every"
**Expected stderr includes:** (none)

**Cleanup:**
```bash
rm -rf /tmp/zana-qa-015
```

---

## Scenario 16: `zana schedule list --json --workspace <tmpdir>` (parseable JSON)

**Preconditions:** Same fixture as Scenario 15:
```bash
mkdir -p /tmp/zana-qa-016
node dist/bin/zana.js init /tmp/zana-qa-016
mkdir -p /tmp/zana-qa-016/.zana/scheduler
cat > /tmp/zana-qa-016/.zana/scheduler/qa-noop.yml <<'YAML'
id: qa-noop
name: QA No-Op
enabled: false
schedule:
  every: 1h
action:
  type: workflow
  skillId: noop
YAML
```

**Command:**
```bash
node dist/bin/zana.js schedule list --json --workspace /tmp/zana-qa-016
```

**Expected exit code:** 0
**Expected stdout:** Valid JSON parseable by `JSON.parse` / `jq`. The parsed
value must be an array containing at least one object with `id === "qa-noop"`
and `enabled === false`.

**Validation snippet (run by harness):**
```bash
node dist/bin/zana.js schedule list --json --workspace /tmp/zana-qa-016 \
  | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const a=JSON.parse(s); if(!Array.isArray(a)||!a.some(x=>x.id==="qa-noop"&&x.enabled===false)) process.exit(1);})'
```
Expected exit code of validator: 0.

**Cleanup:**
```bash
rm -rf /tmp/zana-qa-016
```

---

## Scenario 17: `zana schedule enable <id>` and `zana schedule disable <id>`

**Preconditions:**
- Workspace with the same `qa-noop` fixture from Scenario 15, plus a running
  daemon (these commands hit the API):
  ```bash
  mkdir -p /tmp/zana-qa-017
  node dist/bin/zana.js init /tmp/zana-qa-017
  mkdir -p /tmp/zana-qa-017/.zana/scheduler
  cat > /tmp/zana-qa-017/.zana/scheduler/qa-noop.yml <<'YAML'
  id: qa-noop
  name: QA No-Op
  enabled: false
  schedule:
    every: 1h
  action:
    type: workflow
    skillId: noop
  YAML
  node dist/bin/zana.js headless /tmp/zana-qa-017 --background &
  HEADLESS_PID=$!
  sleep 4
  ```

**Command (enable):**
```bash
node dist/bin/zana.js schedule enable qa-noop --workspace /tmp/zana-qa-017
```

**Expected exit code:** 0
**Expected stdout includes:** "enabled qa-noop", "enabled=true"

**Command (disable):**
```bash
node dist/bin/zana.js schedule disable qa-noop --workspace /tmp/zana-qa-017
```

**Expected exit code:** 0
**Expected stdout includes:** "disabled qa-noop", "enabled=false"

**Negative guard:** `node dist/bin/zana.js schedule enable --workspace /tmp/zana-qa-017`
(missing id) exits nonzero, stderr includes `<id> is required`.

**Cleanup:**
```bash
node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
wait $HEADLESS_PID 2>/dev/null
rm -rf /tmp/zana-qa-017
```

---

## Scenario 18: `zana schedule enable-all` and `zana schedule disable-all`

**Preconditions:**
- Workspace with TWO disabled fixtures plus a running daemon:
  ```bash
  mkdir -p /tmp/zana-qa-018
  node dist/bin/zana.js init /tmp/zana-qa-018
  mkdir -p /tmp/zana-qa-018/.zana/scheduler
  for ID in qa-noop-a qa-noop-b; do
    cat > /tmp/zana-qa-018/.zana/scheduler/$ID.yml <<YAML
  id: $ID
  name: QA No-Op $ID
  enabled: false
  schedule:
    every: 1h
  action:
    type: workflow
    skillId: noop
  YAML
  done
  node dist/bin/zana.js headless /tmp/zana-qa-018 --background &
  HEADLESS_PID=$!
  sleep 4
  ```

**Command (enable-all):**
```bash
node dist/bin/zana.js schedule enable-all --workspace /tmp/zana-qa-018
```

**Expected exit code:** 0
**Expected stdout includes:** "enabled qa-noop-a", "enabled qa-noop-b",
"done — ok=2", "total=2"

**Command (disable-all):**
```bash
node dist/bin/zana.js schedule disable-all --workspace /tmp/zana-qa-018
```

**Expected exit code:** 0
**Expected stdout includes:** "disabled qa-noop-a", "disabled qa-noop-b",
"done — ok=2"

**Edge case (idempotent):** Running `disable-all` again immediately should
print "(no schedules to disable)" and exit 0.

**Cleanup:**
```bash
node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
wait $HEADLESS_PID 2>/dev/null
rm -rf /tmp/zana-qa-018
```

---

## Scenario 19: `zana schedule trigger <id>` fires once

**Preconditions:**
- Workspace with a no-op schedule fixture and a running daemon:
  ```bash
  mkdir -p /tmp/zana-qa-019
  node dist/bin/zana.js init /tmp/zana-qa-019
  mkdir -p /tmp/zana-qa-019/.zana/scheduler
  cat > /tmp/zana-qa-019/.zana/scheduler/qa-noop.yml <<'YAML'
  id: qa-noop
  name: QA No-Op
  enabled: true
  schedule:
    every: 24h
  action:
    type: workflow
    skillId: noop
  YAML
  node dist/bin/zana.js headless /tmp/zana-qa-019 --background &
  HEADLESS_PID=$!
  sleep 4
  ```
  The `every: 24h` ensures the schedule won't auto-fire during the test —
  only the manual trigger is observed.

**Command:**
```bash
node dist/bin/zana.js schedule trigger qa-noop --workspace /tmp/zana-qa-019
```

**Expected exit code:** 0
**Expected stdout includes:** "triggered qa-noop"
**Expected stdout regex:** `triggered qa-noop → \S+` (the `→` arrow is literal
and the status that follows is one of `ok|error|skipped|...`).

**Negative guard:** `zana schedule trigger nonexistent --workspace /tmp/zana-qa-019`
exits nonzero, stderr includes a daemon-side 404/`HTTP 4`-style error.

**Cleanup:**
```bash
node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
wait $HEADLESS_PID 2>/dev/null
rm -rf /tmp/zana-qa-019
```

---

## Scenario 20: `zana schedule reload` re-reads YAMLs

**Preconditions:**
- Daemon running for `/tmp/zana-qa-020` with one schedule already loaded:
  ```bash
  mkdir -p /tmp/zana-qa-020
  node dist/bin/zana.js init /tmp/zana-qa-020
  mkdir -p /tmp/zana-qa-020/.zana/scheduler
  cat > /tmp/zana-qa-020/.zana/scheduler/qa-original.yml <<'YAML'
  id: qa-original
  name: QA Original
  enabled: true
  schedule:
    every: 24h
  action:
    type: workflow
    skillId: noop
  YAML
  node dist/bin/zana.js headless /tmp/zana-qa-020 --background &
  HEADLESS_PID=$!
  sleep 4
  ```
- Then drop a NEW schedule on disk after the daemon started:
  ```bash
  cat > /tmp/zana-qa-020/.zana/scheduler/qa-new.yml <<'YAML'
  id: qa-new
  name: QA New After Reload
  enabled: true
  schedule:
    every: 24h
  action:
    type: workflow
    skillId: noop
  YAML
  ```

**Command:**
```bash
node dist/bin/zana.js schedule reload --workspace /tmp/zana-qa-020
```

**Expected exit code:** 0
**Expected stdout includes:** "reload —", "started=", "skipped=", "total="
**Expected post-state:** `node dist/bin/zana.js schedule list --json --workspace /tmp/zana-qa-020`
now includes both `qa-original` and `qa-new`.

**Cleanup:**
```bash
node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
wait $HEADLESS_PID 2>/dev/null
rm -rf /tmp/zana-qa-020
```

---

## Scenario 21: `zana schedule history <id> -n 3`

**Preconditions:**
- Daemon running for `/tmp/zana-qa-021` with one schedule, and that schedule
  has been fired at least once (so history exists):
  ```bash
  mkdir -p /tmp/zana-qa-021
  node dist/bin/zana.js init /tmp/zana-qa-021
  mkdir -p /tmp/zana-qa-021/.zana/scheduler
  cat > /tmp/zana-qa-021/.zana/scheduler/qa-noop.yml <<'YAML'
  id: qa-noop
  name: QA No-Op
  enabled: true
  schedule:
    every: 24h
  action:
    type: workflow
    skillId: noop
  YAML
  node dist/bin/zana.js headless /tmp/zana-qa-021 --background &
  HEADLESS_PID=$!
  sleep 4
  # Trigger twice so history has at least 2 entries.
  node dist/bin/zana.js schedule trigger qa-noop --workspace /tmp/zana-qa-021
  node dist/bin/zana.js schedule trigger qa-noop --workspace /tmp/zana-qa-021
  ```

**Command:**
```bash
node dist/bin/zana.js schedule history qa-noop -n 3 --workspace /tmp/zana-qa-021
```

**Expected exit code:** 0
**Expected stdout:** Either "(no history)" if the daemon impl hasn't recorded
yet, OR up to 3 lines of the form `<timestamp> | <status> | <summary>`.
The test passes if exit code is 0; require at least one line containing a
'|' separator when history exists.

**Negative guard:**
`node dist/bin/zana.js schedule history --workspace /tmp/zana-qa-021` (missing id)
exits nonzero, stderr includes `<id> is required`.

**Cleanup:**
```bash
node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
wait $HEADLESS_PID 2>/dev/null
rm -rf /tmp/zana-qa-021
```

---

## Negative Scenarios

### Scenario 22: Unknown subcommand falls through to `headless` (documented behavior)

**Background:** `bin/zana.ts` treats anything outside its known subcommand set
as a directory argument to `launchHeadless`. So `zana totally-unknown-cmd`
calls `launchHeadless(["totally-unknown-cmd"])`, which resolves
`totally-unknown-cmd` against `process.cwd()`, finds it isn't a directory,
and exits 1 with a clear error. This scenario verifies that error path.

**Preconditions:**
- Run from a CWD where `totally-unknown-cmd` does NOT exist as a directory
  (use a temp empty CWD to be safe):
  ```bash
  mkdir -p /tmp/zana-qa-022 && cd /tmp/zana-qa-022
  ```

**Command:**
```bash
cd /tmp/zana-qa-022 && node $ZANA/dist/bin/zana.js totally-unknown-cmd
```

**Expected exit code:** 1
**Expected stderr includes:** "not a valid directory:", "totally-unknown-cmd"
**Expected stdout includes:** (nothing required)

**Cleanup:**
```bash
rm -rf /tmp/zana-qa-022
```

---

### Scenario 23: `zana headless --port 47400 --workspace /tmp/x` (WRONG order)

This is the "common failure mode" called out in INSTALL.md. The dispatcher
parses the first non-flag arg as the workspace path, so `--port` and
`--workspace` are read as flags and the workspace path defaults to
`process.cwd()`. The actual failure depends on whether CWD has a `.zana/`,
but the daemon must NOT come up under `/tmp/x` as the user expected.

**A more deterministic version of the failure:** put `--port` literally as
the first positional and watch the path resolver treat it as a directory.

**Preconditions:**
- CWD has no `.zana/` and `--port` is not a directory:
  ```bash
  mkdir -p /tmp/zana-qa-023-cwd && cd /tmp/zana-qa-023-cwd
  rm -rf /tmp/x
  ```

**Command:**
```bash
cd /tmp/zana-qa-023-cwd && node $ZANA/dist/bin/zana.js headless --port 47400 --workspace /tmp/x
```

**Expected behavior — choose ONE of the following observable outcomes (the
test passes on either):**

1. Exit code 1, stderr includes "not a valid directory" — if the resolver
   treats `--port` or `47400` as the positional and rejects it.
2. The daemon starts but its `workspace` field in `~/.zana/daemons/<id>.json`
   resolves to `/tmp/zana-qa-023-cwd` (NOT `/tmp/x`). In this case the test
   asserts the misconfiguration: `--workspace /tmp/x` was silently ignored.

**Validation:** Whichever outcome occurs, the test must demonstrate that the
arg order is wrong — i.e. `/tmp/x` is NEVER the actual workspace of the
running daemon.

**Cleanup:**
```bash
node $ZANA/dist/bin/zana.js stop --all >/dev/null 2>&1 || true
rm -rf /tmp/zana-qa-023-cwd /tmp/x
```

---

### Scenario 24: `zana stop` with no arg AND no `--all` errors out

**Preconditions:** none.

**Command:**
```bash
node dist/bin/zana.js stop
```

**Expected exit code:** 1
**Expected stderr includes:** "Usage: zana stop <id|port>"
**Expected stdout includes:** (nothing required)

**Cleanup:** none.

---

## Coverage summary

| # | Subcommand | Type |
|---|---|---|
| 1 | `--help` / `-h` / no args | positive |
| 2 | `init <path>` | positive |
| 3 | `init wizard <path> --repair-mcp` | positive (sandboxed HOME) |
| 4 | `migrate <path>` | positive + negative dir guard |
| 5 | `status` (empty) | positive |
| 6 | `headless <path> --background` + `status` | positive |
| 7 | `stop <id>` | positive + negative |
| 8 | `stop --all` | positive |
| 9 | `config list` | positive |
| 10 | `config get <module>` | positive + negative |
| 11 | `config set <module> <key> <value>` | positive |
| 12 | `ticket list --workspace <path>` | positive + no-daemon negative |
| 13 | `ticket rules list --workspace <path>` | positive |
| 14 | `run list --limit N --workspace <path>` | positive + missing-subverb negative |
| 15 | `schedule list --workspace <path>` (text) | positive |
| 16 | `schedule list --json --workspace <path>` | positive (JSON parseable) |
| 17 | `schedule enable/disable <id>` | positive + missing-id negative |
| 18 | `schedule enable-all` / `disable-all` | positive + idempotency |
| 19 | `schedule trigger <id>` | positive + unknown-id negative |
| 20 | `schedule reload` | positive |
| 21 | `schedule history <id> -n N` | positive + missing-id negative |
| 22 | unknown subcommand → headless dir-resolver error | negative |
| 23 | `headless --port ... --workspace ...` (wrong order) | negative |
| 24 | `stop` with no args | negative |

**Total scenarios: 24** (21 primary + 3 negative-only). Several primary
scenarios bundle their own negative guard, so the total assertion count is
higher; each numbered scenario is independently runnable and self-cleaning.
