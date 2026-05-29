# QA Scenarios — `zana-daemon`

Surface under test: `node packages/core/dist/bin/daemon.js` (source: `packages/core/bin/daemon.ts`).

All scenarios are **WRITE-ONLY** — do not execute here. Scenarios that mutate
`~/.zana/plugins/`, `~/.zana/settings.json`, or workspace state must use
unique tmpnames and clean up after themselves.

**Service install/uninstall are gated** behind `ZANA_QA_INSTALL_SERVICE=1`
and marked DEFERRED otherwise — they touch launchd/systemd and cannot be
rolled back cleanly inside CI.

**Preconditions for ALL scenarios:**
- Repo is at `/Users/grebmann/Documents/claude-workspace/zana`
- `npm run build` has been run so `packages/core/dist/bin/daemon.js` exists
- `cd` into the repo root before running commands (relative paths assume this)

---

## Positive scenarios

### Scenario 1: `--help` / `-h` prints usage
**Preconditions:** daemon.js built.
**Command:**
```bash
node packages/core/dist/bin/daemon.js --help
```
**Expected exit code:** 0
**Expected stdout includes:** "Usage: zana-daemon"
**Expected stdout includes:** "service install"
**Expected stdout includes:** "plugin init"
**Expected stderr includes:** (none)
**Cleanup:** none

Also verify the short form:
```bash
node packages/core/dist/bin/daemon.js -h
```
Same expectations as above.

---

### Scenario 2: `service status` reports installed + status
**Preconditions:** none — works whether or not the service is installed.
**Command:**
```bash
node packages/core/dist/bin/daemon.js service status
```
**Expected exit code:** 0
**Expected stdout includes:** "installed: "
**Expected stdout includes:** "status: "
**Notes:** stdout matches `installed: (true|false)` followed by `status: (running \(pid \d+\)|stopped)`.
**Cleanup:** none

---

### Scenario 3: `service install` (DEFERRED unless `ZANA_QA_INSTALL_SERVICE=1`)
**Preconditions:** `ZANA_QA_INSTALL_SERVICE=1` set in env. Service is NOT already installed (run scenario 2 first to confirm `installed: false`). System-altering — installs launchd plist on macOS / systemd unit on Linux.
**Command:**
```bash
ZANA_QA_INSTALL_SERVICE=1 node packages/core/dist/bin/daemon.js service install
```
**Expected exit code:** 0
**Expected stdout includes:** "Service installed."
**Cleanup:** Run scenario 4 (`service uninstall`) to remove the plist/unit, regardless of subsequent scenario results.
**DEFERRED:** if `ZANA_QA_INSTALL_SERVICE` is unset, skip this scenario and report as DEFERRED.

---

### Scenario 4: `service uninstall` (DEFERRED unless `ZANA_QA_INSTALL_SERVICE=1`)
**Preconditions:** `ZANA_QA_INSTALL_SERVICE=1`. Service was installed (typically by scenario 3).
**Command:**
```bash
ZANA_QA_INSTALL_SERVICE=1 node packages/core/dist/bin/daemon.js service uninstall
```
**Expected exit code:** 0
**Expected stdout includes:** "Service uninstalled."
**Cleanup:** Verify with `service status` that `installed: false`.
**DEFERRED:** if `ZANA_QA_INSTALL_SERVICE` is unset, skip and report as DEFERRED.

---

### Scenario 5: `service logs 10` prints up to 10 lines or empty
**Preconditions:** none — works whether the service is installed or not. If logs do not exist, output is empty.
**Command:**
```bash
node packages/core/dist/bin/daemon.js service logs 10
```
**Expected exit code:** 0
**Expected stdout:** at most 10 lines (count via `wc -l`); may be empty if no log file exists.
**Expected stderr includes:** (none)
**Cleanup:** none

---

### Scenario 6: `plugin list` prints table or empty marker
**Preconditions:** `~/.zana/plugins/` may or may not exist; the command will create it.
**Command:**
```bash
node packages/core/dist/bin/daemon.js plugin list
```
**Expected exit code:** 0
**Expected stdout includes:** EITHER `"No plugins installed."` OR a header row containing `"ID"` and `"Name"` and `"Version"` and `"Status"`.
**Cleanup:** none (the `mkdirSync(PLUGINS_DIR, recursive)` is benign).

---

### Scenario 7: `plugin init <tmpname>` scaffolds a plugin
**Preconditions:** Pick a unique tmpname, e.g. `qa-tmp-${RANDOM}`. Directory `~/.zana/plugins/<tmpname>` MUST NOT already exist.
**Setup:**
```bash
TMPNAME="qa-tmp-$$-$RANDOM"
test ! -e "$HOME/.zana/plugins/$TMPNAME"
```
**Command:**
```bash
node packages/core/dist/bin/daemon.js plugin init "$TMPNAME"
```
**Expected exit code:** 0
**Expected stdout includes:** "Plugin scaffolded at "
**Expected stdout includes:** the tmpname value
**Post-checks:**
- `~/.zana/plugins/$TMPNAME/` exists and is a directory
- `~/.zana/plugins/$TMPNAME/plugin.json` exists and parses as JSON
**Cleanup (MANDATORY):**
```bash
rm -rf "$HOME/.zana/plugins/$TMPNAME"
```

---

### Scenario 8: `plugin enable <id>` flips `enabled=true`
**Preconditions:** Use a synthetic id (no real plugin needed; the command writes settings regardless). Snapshot `~/.zana/settings.json` first so it can be restored.
**Setup:**
```bash
TMPID="qa-enable-$$-$RANDOM"
cp "$HOME/.zana/settings.json" "$HOME/.zana/settings.json.qa-bak" 2>/dev/null || true
```
**Command:**
```bash
node packages/core/dist/bin/daemon.js plugin enable "$TMPID"
```
**Expected exit code:** 0
**Expected stdout includes:** `"Plugin "` and the tmpid and `" enabled."`
**Post-checks:** `jq ".plugins[\"$TMPID\"].enabled" ~/.zana/settings.json` returns `true`.
**Cleanup (MANDATORY):**
```bash
# Remove the synthetic entry; restore the backup if we made one.
if [ -f "$HOME/.zana/settings.json.qa-bak" ]; then
  mv "$HOME/.zana/settings.json.qa-bak" "$HOME/.zana/settings.json"
else
  jq "del(.plugins[\"$TMPID\"])" ~/.zana/settings.json > ~/.zana/settings.json.tmp \
    && mv ~/.zana/settings.json.tmp ~/.zana/settings.json
fi
```

---

### Scenario 9: `plugin disable <id>` flips `enabled=false`
**Preconditions:** As scenario 8. Run on the same `$TMPID` (so first enable, then disable) OR on a fresh tmpid; both write the same field.
**Setup:**
```bash
TMPID="qa-disable-$$-$RANDOM"
cp "$HOME/.zana/settings.json" "$HOME/.zana/settings.json.qa-bak" 2>/dev/null || true
```
**Command:**
```bash
node packages/core/dist/bin/daemon.js plugin disable "$TMPID"
```
**Expected exit code:** 0
**Expected stdout includes:** `" disabled."`
**Post-checks:** `jq ".plugins[\"$TMPID\"].enabled" ~/.zana/settings.json` returns `false`.
**Cleanup (MANDATORY):** same as scenario 8.

---

### Scenario 10: `plugin link <abs-path>` creates a symlink
**Preconditions:** A fixture plugin directory containing a valid `plugin.json` with an `id` field. Build one in tmpdir.
**Setup:**
```bash
FIXTURE=$(mktemp -d -t zana-qa-link.XXXXXX)
TMPID="qa-link-$$-$RANDOM"
cat > "$FIXTURE/plugin.json" <<EOF
{ "id": "$TMPID", "name": "QA Link Fixture", "version": "0.0.0" }
EOF
test ! -e "$HOME/.zana/plugins/$TMPID"
```
**Command:**
```bash
node packages/core/dist/bin/daemon.js plugin link "$FIXTURE"
```
**Expected exit code:** 0
**Expected stdout includes:** `"Linked "` and the tmpid and `" -> "` and the fixture path
**Post-checks:**
- `[ -L "$HOME/.zana/plugins/$TMPID" ]` (it is a symlink)
- `readlink "$HOME/.zana/plugins/$TMPID"` resolves to `$FIXTURE`
**Cleanup (MANDATORY):**
```bash
rm -f "$HOME/.zana/plugins/$TMPID"
rm -rf "$FIXTURE"
```

---

### Scenario 11: `plugin unlink <id>` removes the symlink
**Preconditions:** A symlink for `$TMPID` exists in `~/.zana/plugins/` (typically created by scenario 10 — chain it).
**Setup:** see scenario 10. Do NOT run scenario 10's cleanup yet.
**Command:**
```bash
node packages/core/dist/bin/daemon.js plugin unlink "$TMPID"
```
**Expected exit code:** 0
**Expected stdout includes:** `"Unlinked "` and the tmpid
**Post-checks:** `[ ! -e "$HOME/.zana/plugins/$TMPID" ]`
**Cleanup (MANDATORY):**
```bash
rm -rf "$FIXTURE"
```

---

### Scenario 12: `config list` prints module list with `system` first
**Preconditions:** none — built-in `system` schema is always present.
**Command:**
```bash
node packages/core/dist/bin/daemon.js config list
```
**Expected exit code:** 0
**Expected stdout includes:** `"system: "`
**Expected stdout includes:** `"maxConcurrentAgents="`
**Expected stdout includes:** `"initTimeout="`
**Notes:** Additional discovered modules (under `packages/core/modules/*/module.json`) appear with `(enabled)` or `(disabled)` markers — exact set is environment-dependent.
**Cleanup:** none

---

### Scenario 13: `config get system` prints the system config keys
**Preconditions:** none.
**Command:**
```bash
node packages/core/dist/bin/daemon.js config get system
```
**Expected exit code:** 0
**Expected stdout includes:** `"maxConcurrentAgents:"`
**Expected stdout includes:** `"initTimeout:"`
**Expected stdout includes:** `"suspendTimeout:"`
**Expected stdout includes:** `"hotReload:"`
**Cleanup:** none

---

### Scenario 14: `config set system maxConcurrentAgents 7` persists
**Preconditions:** Snapshot existing system config so it can be restored.
**Setup:**
```bash
node packages/core/dist/bin/daemon.js config get system > /tmp/zana-qa-system-before.txt
```
**Command:**
```bash
node packages/core/dist/bin/daemon.js config set system maxConcurrentAgents 7
```
**Expected exit code:** 0
**Expected stdout includes:** `"system.maxConcurrentAgents = 7"`
**Post-checks:** `node packages/core/dist/bin/daemon.js config get system` shows `maxConcurrentAgents: 7`.
**Cleanup (MANDATORY):**
```bash
# Reset to defaults — this restores maxConcurrentAgents=10 per the SYSTEM_SCHEMA.
node packages/core/dist/bin/daemon.js config reset system
```

---

### Scenario 15: `config reset system` restores defaults
**Preconditions:** scenario 14 has run (or system was modified some other way).
**Command:**
```bash
node packages/core/dist/bin/daemon.js config reset system
```
**Expected exit code:** 0
**Expected stdout includes:** `"system config reset to defaults"`
**Post-checks:** `config get system` shows `maxConcurrentAgents: 10`, `initTimeout: 10000`, `suspendTimeout: 5000`, `hotReload: false`.
**Cleanup:** none (this scenario IS the cleanup).

---

### Scenario 16: Default launch — `--background` forks daemon, registry record appears
**Preconditions:** No daemon currently running for the chosen tmp workspace. `zana` CLI available on PATH for shutdown.
**Setup:**
```bash
TMPWS=$(mktemp -d -t zana-qa-daemon.XXXXXX)
TMPPID=$(mktemp -t zana-qa-daemon-pid.XXXXXX)
TMPPORT=47499  # avoid the default 47402 to keep clear of any real daemon
```
**Command (positional-args ordering bug regression — flags BEFORE positional):**
```bash
node packages/core/dist/bin/daemon.js --port $TMPPORT --workspace "$TMPWS" --pid-file "$TMPPID" --background
```
**Expected exit code:** 0
**Expected stdout includes:** `"forked to background (pid "`
**Expected stdout includes:** `"API: http://127.0.0.1:$TMPPORT"`
**Post-checks:**
- Wait up to 10s for the registry to be populated.
- `node packages/core/dist/bin/daemon.js` running for `$TMPWS` should be discoverable via the daemon registry — i.e. `cat ~/.zana/daemons/*.json | jq 'select(.workspace == "'$TMPWS'")'` returns a record with a non-zero `pid` and `port == $TMPPORT`.
- The PID file at `$TMPPID` exists and contains a numeric pid.

**Also test the historical positional-args ordering bug** — run a SECOND invocation against a different tmp workspace, with the same flag ordering as the failing-mode case (`--port` first, `--workspace` second):
```bash
TMPWS2=$(mktemp -d -t zana-qa-daemon2.XXXXXX)
TMPPID2=$(mktemp -t zana-qa-daemon-pid2.XXXXXX)
TMPPORT2=47500
node packages/core/dist/bin/daemon.js --port $TMPPORT2 --workspace "$TMPWS2" --pid-file "$TMPPID2" --background
```
The workspace MUST be parsed as `$TMPWS2`, NOT swallowed by `--port`. Confirm via the registry that the record's `workspace` is exactly `$TMPWS2`.

**Cleanup (MANDATORY):**
```bash
zana stop --all 2>/dev/null || true
# Belt-and-suspenders: kill by pid file if still running
for pf in "$TMPPID" "$TMPPID2"; do
  if [ -f "$pf" ]; then
    kill "$(cat "$pf")" 2>/dev/null || true
    rm -f "$pf"
  fi
done
rm -rf "$TMPWS" "$TMPWS2"
```

---

## Negative scenarios

### Scenario N1: Unknown subcommand exits nonzero
**Preconditions:** none.
**Command:**
```bash
node packages/core/dist/bin/daemon.js bogus-subcommand
```
**Expected exit code:** nonzero
**Notes:** Unknown top-level tokens that aren't `service`/`plugin`/`config` and don't start with `--` are interpreted by the default-launch path as a workspace path. The expected nonzero exit comes from `directory does not exist: <resolved-path>` on stderr.
**Expected stderr includes:** `"directory does not exist:"`
**Cleanup:** none

---

### Scenario N2: `plugin enable` with no id exits nonzero
**Preconditions:** none.
**Command:**
```bash
node packages/core/dist/bin/daemon.js plugin enable
```
**Expected exit code:** 1
**Expected stderr includes:** `"plugin enable requires <id>"`
**Cleanup:** none

---

### Scenario N3: `plugin link /nonexistent` exits nonzero
**Preconditions:** `/nonexistent-zana-qa-path-$RANDOM` MUST NOT exist.
**Setup:**
```bash
NOPATH="/nonexistent-zana-qa-$$-$RANDOM"
test ! -e "$NOPATH"
```
**Command:**
```bash
node packages/core/dist/bin/daemon.js plugin link "$NOPATH"
```
**Expected exit code:** 1
**Expected stderr includes:** `"no plugin.json found at "`
**Cleanup:** none

---

### Scenario N4: `plugin unlink` for non-existent plugin exits nonzero
**Preconditions:** `~/.zana/plugins/<id>` MUST NOT exist for the chosen id.
**Setup:**
```bash
GHOST_ID="qa-ghost-$$-$RANDOM"
test ! -e "$HOME/.zana/plugins/$GHOST_ID"
```
**Command:**
```bash
node packages/core/dist/bin/daemon.js plugin unlink "$GHOST_ID"
```
**Expected exit code:** 1
**Expected stderr includes:** `"plugin not found: "`
**Cleanup:** none

---

## Summary

- **Positive scenarios:** 16 (1–16)
- **Negative scenarios:** 4 (N1–N4)
- **DEFERRED unless `ZANA_QA_INSTALL_SERVICE=1`:** scenarios 3, 4
- **Total:** 20 scenarios
