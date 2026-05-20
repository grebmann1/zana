#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/grebmann1/zana.git}"
PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
TARGET_WORKSPACE="${TARGET_WORKSPACE:-$(pwd)}"
WORKDIR=""
SETUP_MCP=1
RUN_DOCTOR=1
RUN_INIT=1
REPAIR_MCP=1

print_step() { echo "[zana] $1"; }
print_ok() { echo "[zana] ✓ $1"; }
print_warn() { echo "[zana] ⚠ $1"; }

usage() {
  cat <<'EOF'
Zana installer

Usage:
  bash scripts/install.sh [options]
  curl -fsSL https://raw.githubusercontent.com/grebmann1/zana/main/scripts/install.sh | bash -s -- [options]

Options:
  --workspace <path>     Target workspace for `zana init wizard` (default: $PWD)
  --no-init              Skip project initialization
  --no-repair-mcp        Do not pass --repair-mcp to init wizard
  --no-setup-mcp         Skip explicit `claude mcp add` setup step
  --no-doctor            Skip post-install diagnostics
  --help, -h             Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace=*)
      TARGET_WORKSPACE="${1#*=}"
      shift
      ;;
    --workspace)
      TARGET_WORKSPACE="${2:-$TARGET_WORKSPACE}"
      shift 2
      ;;
    --no-init)
      RUN_INIT=0
      shift
      ;;
    --no-setup-mcp)
      SETUP_MCP=0
      shift
      ;;
    --no-doctor)
      RUN_DOCTOR=0
      shift
      ;;
    --no-repair-mcp)
      REPAIR_MCP=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      shift
      ;;
  esac
done

check_requirements() {
  print_step "Checking requirements..."

  if ! command -v node >/dev/null 2>&1; then
    echo "[zana] Node.js is required (>=20)."
    exit 1
  fi

  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "${NODE_MAJOR}" -lt 20 ]; then
    echo "[zana] Detected Node $(node -v). Please upgrade to Node >=20."
    exit 1
  fi
  print_ok "Node $(node -v)"

  if ! command -v npm >/dev/null 2>&1; then
    echo "[zana] npm is required."
    exit 1
  fi
  print_ok "npm $(npm -v)"
}

resolve_project_root() {
  if [ -f "${PROJECT_ROOT}/package.json" ] && [ -f "${PROJECT_ROOT}/bin/zana.ts" ]; then
    return
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "[zana] git is required when running install outside the repository."
    exit 1
  fi
  WORKDIR="$(mktemp -d)"
  print_step "Cloning Zana into temporary directory..."
  git clone --depth 1 "${REPO_URL}" "${WORKDIR}/zana"
  PROJECT_ROOT="${WORKDIR}/zana"
}

install_cli() {
  if [ ! -d "${TARGET_WORKSPACE}" ]; then
    echo "[zana] Target workspace does not exist: ${TARGET_WORKSPACE}"
    exit 1
  fi

  print_step "Installing workspace dependencies..."
  npm install --prefix "${PROJECT_ROOT}"

  print_step "Building runtime dist artifacts..."
  npm run build:runtime --prefix "${PROJECT_ROOT}"

  print_step "Installing Zana CLI globally..."
  npm install -g "${PROJECT_ROOT}"
  print_ok "Global CLI installed"
}

setup_mcp_server() {
  if [ "${SETUP_MCP}" != "1" ]; then
    return
  fi

  print_step "Configuring Claude MCP server..."
  if ! command -v claude >/dev/null 2>&1; then
    print_warn "Claude CLI not found; skipping automatic MCP setup"
    return
  fi

  # Remove legacy key in all scopes (best-effort).
  claude mcp remove hive -s local >/dev/null 2>&1 || true
  claude mcp remove hive -s project >/dev/null 2>&1 || true
  claude mcp remove hive -s user >/dev/null 2>&1 || true

  # Ensure canonical MCP registration in the target workspace local scope.
  local local_mcp_bin="${PROJECT_ROOT}/packages/mcp/dist/bin/zana-mcp-server.js"
  local escaped_local_mcp_bin="${local_mcp_bin//\"/\\\"}"
  local mcp_cmd="node \"${escaped_local_mcp_bin}\" || npx --yes zana-mcp-server"
  local out=""
  if out="$(cd "${TARGET_WORKSPACE}" && claude mcp add -s local zana -- sh -lc "${mcp_cmd}" 2>&1)"; then
    print_ok "MCP server configured (zana, local scope)"
    return
  fi
  if printf "%s" "${out}" | rg -q "already exists"; then
    print_ok "MCP server already configured (zana, local scope)"
    return
  fi

  # Fallback for CLI variants that don't need "--" separator.
  if out="$(cd "${TARGET_WORKSPACE}" && claude mcp add -s local zana sh -lc "${mcp_cmd}" 2>&1)"; then
    print_ok "MCP server configured (zana, local scope)"
    return
  fi
  if printf "%s" "${out}" | rg -q "already exists"; then
    print_ok "MCP server already configured (zana, local scope)"
    return
  fi

  # Last-resort user-scope registration if local add fails.
  if out="$(claude mcp add -s user zana -- sh -lc "${mcp_cmd}" 2>&1)"; then
    print_ok "MCP server configured (zana, user scope fallback)"
    return
  fi
  if printf "%s" "${out}" | rg -q "already exists"; then
    print_ok "MCP server already configured (zana, user scope fallback)"
    return
  fi

  print_warn "Automatic claude mcp add failed; init wizard will still repair MCP settings"
  print_warn "claude mcp output: ${out}"
}

run_init() {
  if [ "${RUN_INIT}" != "1" ]; then
    return
  fi

  print_step "Running guided bootstrap in target workspace..."
  if [ "${REPAIR_MCP}" = "1" ]; then
    zana init wizard "${TARGET_WORKSPACE}" --repair-mcp
  else
    zana init wizard "${TARGET_WORKSPACE}"
  fi
  print_ok "Workspace initialized: ${TARGET_WORKSPACE}"
}

run_doctor() {
  if [ "${RUN_DOCTOR}" != "1" ]; then
    return
  fi

  print_step "Running diagnostics..."
  if zana status >/dev/null 2>&1; then
    print_ok "CLI check passed (`zana status`)"
  else
    print_warn "`zana status` returned non-zero"
  fi
}

show_quickstart() {
  cat <<EOF

[zana] Quick start:
  1) Restart Claude Code (the ⚡ zana footer should appear at the bottom)
  2) In your project, run: /zana <task>
  3) Verify CLI: zana status

[zana] Optional:
  zana init wizard "${TARGET_WORKSPACE}" --repair-mcp   # also repairs statusLine
EOF
}

main() {
  check_requirements
  resolve_project_root
  install_cli
  setup_mcp_server
  run_init
  run_doctor
  show_quickstart

  echo
  print_ok "Install complete."
  if [ -n "${WORKDIR}" ]; then
    echo "[zana] Temporary clone location: ${PROJECT_ROOT}"
  fi
}

main "$@"
