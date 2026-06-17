#!/usr/bin/env bash
#
# Bump the version of every @zana-ai/* package AND their internal dependency
# pins in lockstep. Internal deps are pinned exactly (e.g. "0.2.0"), so the
# version field and every cross-package reference must move together.
#
# Usage:
#   ./scripts/bump-version.sh 0.2.1      # set an explicit version
#   ./scripts/bump-version.sh patch      # 0.2.0 -> 0.2.1
#   ./scripts/bump-version.sh minor      # 0.2.0 -> 0.3.0
#   ./scripts/bump-version.sh major      # 0.2.0 -> 1.0.0
#
# Edits package.json files only — does not build, commit, or publish.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NEW="${1:-}"
if [ -z "$NEW" ]; then
  echo "Usage: $0 <version|patch|minor|major>" >&2
  exit 1
fi

node -e '
const fs = require("fs");
const arg = process.argv[1];
const pkgs = [
  "package.json",
  "packages/contracts/package.json",
  "packages/core/package.json",
  "packages/work/package.json",
  "packages/mcp/package.json",
  "packages/server/package.json",
  "packages/intelligence/package.json",
  "packages/extras/package.json",
  "packages/swarm/package.json",
];

const FROM = require("./packages/core/package.json").version;
let TO = arg;
if (["patch", "minor", "major"].includes(arg)) {
  const [maj, min, pat] = FROM.split(".").map(Number);
  if (arg === "patch") TO = `${maj}.${min}.${pat + 1}`;
  if (arg === "minor") TO = `${maj}.${min + 1}.0`;
  if (arg === "major") TO = `${maj + 1}.0.0`;
}
if (!/^\d+\.\d+\.\d+/.test(TO)) {
  console.error("Invalid target version: " + TO);
  process.exit(1);
}

for (const f of pkgs) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  if (d.version === FROM) d.version = TO;
  for (const field of ["dependencies", "peerDependencies", "devDependencies", "optionalDependencies"]) {
    if (!d[field]) continue;
    for (const k of Object.keys(d[field])) {
      if (k.startsWith("@zana-ai/") && d[field][k] === FROM) d[field][k] = TO;
    }
  }
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  console.log(`bumped ${f}: ${FROM} -> ${TO}`);
}
' "$NEW"
