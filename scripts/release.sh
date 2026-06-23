#!/usr/bin/env bash
#
# Publish all @zana-ai/* packages to npm in dependency order.
#
# Usage:
#   ./scripts/release.sh            # build + publish the current version
#   ./scripts/release.sh --dry-run  # everything except the actual npm publish
#
# Auth: reads NPM_TOKEN from .env (a granular automation token with read/write
# on the @zana-ai scope — these bypass 2FA). The token is written to a TEMP
# npmrc that is deleted on exit, so it never lands in your ~/.npmrc or the repo.
#
# Version bumps are a separate step — run ./scripts/bump-version.sh <new> first.
# npm refuses to republish an existing version, so publishing the same version
# twice is a safe no-op-ish error, not a clobber.

set -euo pipefail

# When launched via `npm run release`, the OUTER npm injects
# `npm_config_userconfig=~/.npmrc` into the env. That lowercase var takes
# PRECEDENCE over the `NPM_CONFIG_USERCONFIG` we export below to point at the
# temp npmrc holding the release token — so publish would silently use the
# host ~/.npmrc instead. If that file carries a STALE registry.npmjs.org token
# (it did, 2026-06-23), publish fails E401/404 even with a valid NPM_TOKEN.
# Unset the shadow so our temp npmrc wins whether run via `npm run` or bash.
unset npm_config_userconfig

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# --- load token from .env ----------------------------------------------------
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

# Auth is only needed for a real publish. A dry run packs locally and never
# contacts the registry, so it can run with no token.
if [ "$DRY_RUN" = "0" ]; then
  if [ -z "${NPM_TOKEN:-}" ]; then
    echo "ERROR: NPM_TOKEN not set. Copy .env.example to .env and add your token." >&2
    exit 1
  fi

  # --- temp npmrc, cleaned up on any exit ------------------------------------
  TMP_NPMRC="$(mktemp)"
  cleanup() { rm -f "$TMP_NPMRC"; }
  trap cleanup EXIT INT TERM

  cat > "$TMP_NPMRC" <<EOF
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
EOF
  export NPM_CONFIG_USERCONFIG="$TMP_NPMRC"

  echo "==> Authenticated as: $(npm whoami)"
fi

# --- build the runtime fresh so dist/ matches package.json versions ----------
echo "==> Building runtime..."
npm run build:runtime

# --- publish in dependency order ---------------------------------------------
# Each package's internal @zana-ai/* deps must already exist on the registry
# at the version being published, so leaves go first. `contracts` is the
# dependency-free base layer (ADR 0010) — it MUST publish before any consumer.
PKGS=(contracts core swarm intelligence extras work server mcp)

VERSION="$(node -e "console.log(require('./packages/core/package.json').version)")"
echo "==> Releasing @zana-ai/* @ ${VERSION}"

for p in "${PKGS[@]}"; do
  echo ""
  echo "==> @zana-ai/${p}"

  # Idempotent skip: npm refuses to republish an existing version (and under
  # `set -e` that would abort the WHOLE run before later packages publish). If
  # the local version is already on the registry, skip it — this makes a release
  # resumable after a mid-run stop, and lets a partially-published line (e.g.
  # contracts already at the target, the rest behind) finish cleanly.
  local_v="$(node -e "console.log(require('./packages/${p}/package.json').version)")"
  published_v="$(npm view "@zana-ai/${p}" version 2>/dev/null || true)"
  if [ "$local_v" = "$published_v" ]; then
    echo "    already published at ${local_v} — skipping."
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    npm publish --workspace="@zana-ai/${p}" --access public --dry-run
  else
    npm publish --workspace="@zana-ai/${p}" --access public
  fi
done

echo ""
if [ "$DRY_RUN" = "1" ]; then
  echo "==> Dry run complete — nothing was published."
else
  echo "==> Released @zana-ai/* @ ${VERSION}. Users update with: npm install -g @zana-ai/mcp@latest"
fi
