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
# at the version being published, so leaves go first.
PKGS=(core swarm intelligence extras work server mcp)

VERSION="$(node -e "console.log(require('./packages/core/package.json').version)")"
echo "==> Releasing @zana-ai/* @ ${VERSION}"

for p in "${PKGS[@]}"; do
  echo ""
  echo "==> @zana-ai/${p}"
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
