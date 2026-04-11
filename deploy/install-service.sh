#!/usr/bin/env bash
# Install T3 Code (and optionally the Bridge/Mythos orchestrator) as systemd services.
# Run from anywhere: ./deploy/install-service.sh   or   bash deploy/install-service.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── defaults ─────────────────────────────────────────────────
REPO_ROOT="${T3CODE_REPO:-$DEFAULT_REPO}"
PORT="${T3CODE_PORT:-3773}"
HOST="${T3CODE_HOST:-0.0.0.0}"
SERVICE_NAME="${T3CODE_SERVICE_NAME:-t3code}"
USER_SCOPE=false
SKIP_BUILD=false
DRY_RUN=false
ASSUME_YES=false
CLI_PATH=""
INSTALL_MAIN=true

# Bridge defaults
WITH_BRIDGE=false
BRIDGE_ONLY=false
BRIDGE_PORT="${BRIDGE_PORT:-3100}"
BRIDGE_SERVICE_NAME="${T3CODE_BRIDGE_SERVICE_NAME:-t3code-bridge}"
BRIDGE_T3_WS_URL="${T3_WS_URL:-ws://localhost:3773}"
BRIDGE_ENV_FILE=""

# ── styling (skip if not a TTY) ───────────────────────────────
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  CYAN=$'\033[36m'
  RESET=$'\033[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" BLUE="" CYAN="" RESET=""
fi

die() {
  echo -e "${RED}✗${RESET} $*" >&2
  exit 1
}

ok() {
  echo -e "${GREEN}✓${RESET} $*"
}

info() {
  echo -e "${CYAN}▸${RESET} $*"
}

warn() {
  echo -e "${YELLOW}!${RESET} $*"
}

step() {
  local n="$1"
  local total="$2"
  shift 2
  echo -e "\n${BOLD}${BLUE}[${n}/${total}]${RESET} $*"
}

banner() {
  echo ""
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}${CYAN}║${RESET}  ${BOLD}T3 Code${RESET} — systemd installer                          ${BOLD}${CYAN}║${RESET}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}"
  echo ""
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

  --repo PATH       Repository root (default: parent of deploy/, or \$T3CODE_REPO)
  --port N          Listen port (default: 3773, or \$T3CODE_PORT)
  --host ADDR       Bind address (default: 0.0.0.0, or \$T3CODE_HOST)
  --name NAME       systemd unit name (default: t3code, or \$T3CODE_SERVICE_NAME)
  --path PATH       Full PATH for the service (overrides auto: nvm, ~/.local/bin, bun)
  --user            Install as user service (~/.config/systemd/user/) — no sudo
  --skip-build      Do not run bun install / bun run build
  --dry-run         Print actions only; do not install or run build
  -y, --yes         Non-interactive (no confirmation before install)
  -h, --help        Show this help

Bridge (Project Mythos) options:
  --with-bridge           Also install the bridge orchestrator as a companion service
  --bridge-only           Build/install/start only the bridge service
  --bridge-port N         Bridge UI port (default: 3100, or \$BRIDGE_PORT)
  --bridge-name NAME      Bridge unit name (default: t3code-bridge, or \$T3CODE_BRIDGE_SERVICE_NAME)
  --bridge-t3-url URL     T3 server WS URL for bridge (default: ws://localhost:3773, or \$T3_WS_URL)
  --bridge-env-file PATH  .env file to load in the bridge service (EnvironmentFile=)

Env: \$T3CODE_REPO, \$T3CODE_PORT, \$T3CODE_HOST, \$T3CODE_SERVICE_NAME, \$T3CODE_SERVICE_PATH
     \$BRIDGE_PORT, \$T3CODE_BRIDGE_SERVICE_NAME, \$T3_WS_URL

Examples:
  $(basename "$0")
  $(basename "$0") --repo /home/levi/t3code/t3code --yes
  $(basename "$0") --user --skip-build
  $(basename "$0") --with-bridge --bridge-env-file /home/levi/l3code/apps/bridge/.env
  $(basename "$0") --bridge-only --bridge-env-file /home/levi/l3code/apps/bridge/.env
EOF
}

confirm() {
  if [[ "$ASSUME_YES" == true ]]; then
    return 0
  fi
  local prompt="$1"
  local reply
  read -r -p "$(echo -e "${YELLOW}?${RESET} ${prompt} [y/N] ")" reply
  [[ "${reply,,}" == "y" || "${reply,,}" == "yes" ]]
}

# systemd does not load ~/.profile or nvm — Codex (nvm) and Claude (~/.local/bin) must be on PATH.
build_service_path() {
  local home="$1"
  local parts=()

  if [[ -d "${home}/.local/bin" ]]; then
    parts+=("${home}/.local/bin")
  fi

  local nvm_root="${home}/.nvm/versions/node"
  if [[ -d "$nvm_root" ]]; then
    local latest
    latest="$(ls -1 "$nvm_root" 2>/dev/null | sort -V | tail -n1)"
    if [[ -n "$latest" && -d "${nvm_root}/${latest}/bin" ]]; then
      parts+=("${nvm_root}/${latest}/bin")
    fi
  fi

  local bun_dir
  bun_dir="$(dirname "$BUN_PATH")"
  if [[ -d "$bun_dir" ]]; then
    parts+=("$bun_dir")
  fi

  parts+=("/usr/local/sbin" "/usr/local/bin" "/usr/sbin" "/usr/bin" "/sbin" "/bin")

  local IFS=':'
  echo "${parts[*]}"
}

# ── arg parse ─────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_ROOT="${2:-}"
      [[ -n "$REPO_ROOT" ]] || die "--repo requires a path"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --name)
      SERVICE_NAME="${2:-}"
      shift 2
      ;;
    --path)
      CLI_PATH="${2:-}"
      [[ -n "$CLI_PATH" ]] || die "--path requires a value"
      shift 2
      ;;
    --with-bridge) WITH_BRIDGE=true; shift ;;
    --bridge-only)
      BRIDGE_ONLY=true
      WITH_BRIDGE=true
      INSTALL_MAIN=false
      shift
      ;;
    --bridge-port)
      BRIDGE_PORT="${2:-}"
      shift 2
      ;;
    --bridge-name)
      BRIDGE_SERVICE_NAME="${2:-}"
      shift 2
      ;;
    --bridge-t3-url)
      BRIDGE_T3_WS_URL="${2:-}"
      shift 2
      ;;
    --bridge-env-file)
      BRIDGE_ENV_FILE="${2:-}"
      [[ -n "$BRIDGE_ENV_FILE" ]] || die "--bridge-env-file requires a path"
      shift 2
      ;;
    --user) USER_SCOPE=true; shift ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -y | --yes) ASSUME_YES=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *)
      die "Unknown option: $1 (try --help)"
      ;;
  esac
done

banner

if [[ "$(id -u)" -eq 0 ]]; then
  die "Do not run as root. Use the account that will run T3, e.g.: ${BOLD}sudo -u levi bash ${BASH_SOURCE[0]}${RESET}"
fi

TOTAL_STEPS=5
if [[ "$WITH_BRIDGE" == true && "$INSTALL_MAIN" == true ]]; then
  TOTAL_STEPS=6
fi

# ── preflight ─────────────────────────────────────────────────
step 1 "$TOTAL_STEPS" "Checking repository"
[[ -f "${REPO_ROOT}/apps/server/package.json" ]] ||
  die "Not a T3 Code repo: ${REPO_ROOT} (missing apps/server/package.json)"

ok "Repository: ${BOLD}${REPO_ROOT}${RESET}"

if [[ "$WITH_BRIDGE" == true ]]; then
  [[ -f "${REPO_ROOT}/apps/bridge/package.json" ]] ||
    die "Bridge not found: ${REPO_ROOT} (missing apps/bridge/package.json)"
  ok "Bridge: ${BOLD}${REPO_ROOT}/apps/bridge${RESET}"
fi

command -v bun >/dev/null 2>&1 || die "bun not found in PATH. Install Bun first: https://bun.sh"
BUN_PATH="$(command -v bun)"
[[ "$BUN_PATH" == /* ]] || die "bun path must be absolute for systemd; got: $BUN_PATH"
ok "Bun: ${BUN_PATH}"

if [[ "$DRY_RUN" != true ]]; then
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found"
fi

USER_NAME="$(id -un)"
GROUP_NAME="$(id -gn)"
ok "Run as user: ${USER_NAME} (group ${GROUP_NAME})"

USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
[[ -n "$USER_HOME" && -d "$USER_HOME" ]] || die "Cannot resolve home directory for ${USER_NAME}"

if [[ -n "$CLI_PATH" ]]; then
  SERVICE_PATH="$CLI_PATH"
elif [[ -n "${T3CODE_SERVICE_PATH:-}" ]]; then
  SERVICE_PATH="$T3CODE_SERVICE_PATH"
  info "Using PATH from \$T3CODE_SERVICE_PATH"
else
  SERVICE_PATH="$(build_service_path "$USER_HOME")"
fi

ok "Service PATH (systemd will use this for codex / claude)"
echo -e "    ${DIM}${SERVICE_PATH}${RESET}"

if env PATH="$SERVICE_PATH" HOME="$USER_HOME" command -v codex >/dev/null 2>&1; then
  ok "codex is visible on service PATH"
else
  warn "codex not on service PATH — install the Codex CLI as ${USER_NAME} (https://github.com/openai/codex)"
fi
if env PATH="$SERVICE_PATH" HOME="$USER_HOME" command -v claude >/dev/null 2>&1; then
  ok "claude is visible on service PATH"
else
  warn "claude not on service PATH (only needed for Claude)"
fi

if [[ "$WITH_BRIDGE" == true && -n "$BRIDGE_ENV_FILE" ]]; then
  if [[ -f "$BRIDGE_ENV_FILE" ]]; then
    ok "Bridge EnvironmentFile: ${BRIDGE_ENV_FILE}"
  else
    warn "Bridge EnvironmentFile does not exist yet: ${BRIDGE_ENV_FILE}"
  fi
fi

# ── build ─────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" != true ]]; then
  step 2 "$TOTAL_STEPS" "Installing dependencies (bun install)"
  if [[ "$DRY_RUN" == true ]]; then
    info "Would run: (cd \"${REPO_ROOT}\" && bun install)"
  else
    (cd "$REPO_ROOT" && bun install)
    ok "Dependencies installed"
  fi

  if [[ "$BRIDGE_ONLY" == true ]]; then
    step 3 "$TOTAL_STEPS" "Building bridge UI (bun run build:ui)"
  else
    step 3 "$TOTAL_STEPS" "Building"
  fi
  if [[ "$DRY_RUN" == true ]]; then
    if [[ "$INSTALL_MAIN" == true ]]; then
      info "Would run: (cd \"${REPO_ROOT}\" && bun run build)"
    fi
    if [[ "$WITH_BRIDGE" == true ]]; then
      info "Would run: (cd \"${REPO_ROOT}/apps/bridge\" && bun run build:ui)"
    fi
  else
    if [[ "$INSTALL_MAIN" == true ]]; then
      (cd "$REPO_ROOT" && bun run build)
      ok "Build finished"
    fi
    if [[ "$WITH_BRIDGE" == true ]]; then
      (cd "${REPO_ROOT}/apps/bridge" && bun run build:ui)
      ok "Bridge UI built"
    fi
  fi
else
  step 2 "$TOTAL_STEPS" "Skipping install & build (--skip-build)"
  if [[ "$INSTALL_MAIN" == true ]]; then
    warn "Ensure you already ran: bun install && bun run build"
  else
    warn "Ensure you already ran: bun install"
  fi
  if [[ "$WITH_BRIDGE" == true ]]; then
    warn "And for bridge: (cd apps/bridge && bun run build:ui)"
  fi
  step 3 "$TOTAL_STEPS" "(skipped)"
fi

# ── unit files ───────────────────────────────────────────────
step 4 "$TOTAL_STEPS" "Writing systemd unit(s)"

UNIT_PATH=""
if [[ "$INSTALL_MAIN" == true ]]; then
  if [[ "$USER_SCOPE" == true ]]; then
    UNIT_PATH="${HOME}/.config/systemd/user/${SERVICE_NAME}.service"
  else
    UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
  fi
fi

render_unit() {
  if [[ "$USER_SCOPE" == true ]]; then
    cat <<UNIT
[Unit]
Description=T3 Code (Codex/Claude web UI)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
Environment=NODE_ENV=production
Environment="HOME=${USER_HOME}"
Environment="PATH=${SERVICE_PATH}"
ExecStart=${BUN_PATH} run --cwd apps/server start -- --host ${HOST} --port ${PORT} --no-browser
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
UNIT
  else
    cat <<UNIT
[Unit]
Description=T3 Code (Codex/Claude web UI)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=${USER_NAME}
Group=${GROUP_NAME}
WorkingDirectory=${REPO_ROOT}
Environment=NODE_ENV=production
Environment="HOME=${USER_HOME}"
Environment="PATH=${SERVICE_PATH}"
ExecStart=${BUN_PATH} run --cwd apps/server start -- --host ${HOST} --port ${PORT} --no-browser
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
  fi
}

TMP_UNIT=""
if [[ "$INSTALL_MAIN" == true ]]; then
  TMP_UNIT="$(mktemp)"
  trap 'rm -f "$TMP_UNIT" "${TMP_BRIDGE_UNIT:-}"' EXIT
  render_unit >"$TMP_UNIT"
else
  trap 'rm -f "${TMP_BRIDGE_UNIT:-}"' EXIT
fi

# Bridge unit
BRIDGE_UNIT_PATH=""
TMP_BRIDGE_UNIT=""
if [[ "$WITH_BRIDGE" == true ]]; then
  if [[ "$USER_SCOPE" == true ]]; then
    BRIDGE_UNIT_PATH="${HOME}/.config/systemd/user/${BRIDGE_SERVICE_NAME}.service"
  else
    BRIDGE_UNIT_PATH="/etc/systemd/system/${BRIDGE_SERVICE_NAME}.service"
  fi

  render_bridge_unit() {
    local env_file_line=""
    if [[ -n "$BRIDGE_ENV_FILE" ]]; then
      env_file_line="EnvironmentFile=${BRIDGE_ENV_FILE}"
    fi

    if [[ "$USER_SCOPE" == true ]]; then
      local unit_dependencies=""
      if [[ "$BRIDGE_ONLY" != true ]]; then
        unit_dependencies="${SERVICE_NAME}.service"
      fi
      cat <<UNIT
[Unit]
Description=T3 Code Bridge — Project Mythos (multi-agent orchestrator)
After=network-online.target${unit_dependencies:+ ${unit_dependencies}}
Wants=network-online.target
${unit_dependencies:+Requires=${unit_dependencies}}
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
Environment=NODE_ENV=production
Environment="HOME=${USER_HOME}"
Environment="PATH=${SERVICE_PATH}"
Environment="T3_WS_URL=${BRIDGE_T3_WS_URL}"
Environment="BRIDGE_PORT=${BRIDGE_PORT}"
${env_file_line:+${env_file_line}
}ExecStart=${BUN_PATH} run --cwd apps/bridge start
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
UNIT
    else
      local unit_dependencies=""
      if [[ "$BRIDGE_ONLY" != true ]]; then
        unit_dependencies="${SERVICE_NAME}.service"
      fi
      cat <<UNIT
[Unit]
Description=T3 Code Bridge — Project Mythos (multi-agent orchestrator)
After=network-online.target${unit_dependencies:+ ${unit_dependencies}}
Wants=network-online.target
${unit_dependencies:+Requires=${unit_dependencies}}
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=${USER_NAME}
Group=${GROUP_NAME}
WorkingDirectory=${REPO_ROOT}
Environment=NODE_ENV=production
Environment="HOME=${USER_HOME}"
Environment="PATH=${SERVICE_PATH}"
Environment="T3_WS_URL=${BRIDGE_T3_WS_URL}"
Environment="BRIDGE_PORT=${BRIDGE_PORT}"
${env_file_line:+${env_file_line}
}ExecStart=${BUN_PATH} run --cwd apps/bridge start
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
    fi
  }

  TMP_BRIDGE_UNIT="$(mktemp)"
  render_bridge_unit >"$TMP_BRIDGE_UNIT"
fi

if [[ "$DRY_RUN" == true ]]; then
  if [[ "$INSTALL_MAIN" == true ]]; then
    echo ""
    echo -e "${DIM}--- ${SERVICE_NAME}.service (preview) ---${RESET}"
    sed 's/^/  /' "$TMP_UNIT"
    echo -e "${DIM}--- end ---${RESET}"
  fi
  if [[ "$WITH_BRIDGE" == true ]]; then
    echo ""
    echo -e "${DIM}--- ${BRIDGE_SERVICE_NAME}.service (preview) ---${RESET}"
    sed 's/^/  /' "$TMP_BRIDGE_UNIT"
    echo -e "${DIM}--- end ---${RESET}"
  fi
else
  if [[ "$INSTALL_MAIN" == true ]]; then
    ok "Unit file prepared (${UNIT_PATH})"
  fi
  if [[ "$WITH_BRIDGE" == true ]]; then
    ok "Bridge unit file prepared (${BRIDGE_UNIT_PATH})"
  fi
fi

# ── install & enable ─────────────────────────────────────────
step 5 "$TOTAL_STEPS" "Installing service(s)"

if [[ "$DRY_RUN" == true ]]; then
  if [[ "$USER_SCOPE" == true ]]; then
    if [[ "$INSTALL_MAIN" == true ]]; then
      info "Would: mkdir -p ~/.config/systemd/user && cp unit → ${UNIT_PATH}"
    else
      info "Would: mkdir -p ~/.config/systemd/user"
    fi
    if [[ "$WITH_BRIDGE" == true ]]; then
      info "Would: cp bridge unit → ${BRIDGE_UNIT_PATH}"
    fi
    info "Would: systemctl --user daemon-reload"
    if [[ "$INSTALL_MAIN" == true ]]; then
      info "Would: systemctl --user enable --now ${SERVICE_NAME}.service"
    fi
    if [[ "$WITH_BRIDGE" == true ]]; then
      info "Would: systemctl --user enable --now ${BRIDGE_SERVICE_NAME}.service"
    fi
  else
    if [[ "$INSTALL_MAIN" == true ]]; then
      info "Would: sudo cp → ${UNIT_PATH}"
    fi
    if [[ "$WITH_BRIDGE" == true ]]; then
      info "Would: sudo cp → ${BRIDGE_UNIT_PATH}"
    fi
    info "Would: sudo systemctl daemon-reload"
    if [[ "$INSTALL_MAIN" == true ]]; then
      info "Would: sudo systemctl enable --now ${SERVICE_NAME}.service"
    fi
    if [[ "$WITH_BRIDGE" == true ]]; then
      info "Would: sudo systemctl enable --now ${BRIDGE_SERVICE_NAME}.service"
    fi
  fi
  echo ""
  ok "Dry run complete — no changes made."
  exit 0
fi

echo ""
echo -e "  ${DIM}HOME${RESET}     ${USER_HOME}"
echo -e "  ${DIM}PATH${RESET}     ${SERVICE_PATH}"
echo -e "  ${DIM}Scope${RESET}    $([[ "$USER_SCOPE" == true ]] && echo user || echo system)"
if [[ "$INSTALL_MAIN" == true ]]; then
  echo -e "  ${DIM}Host${RESET}     ${HOST}"
  echo -e "  ${DIM}Port${RESET}     ${PORT}"
  echo -e "  ${DIM}Unit${RESET}     ${UNIT_PATH}"
fi
if [[ "$WITH_BRIDGE" == true ]]; then
  echo ""
  echo -e "  ${DIM}Bridge${RESET}"
  echo -e "  ${DIM}  UI${RESET}     http://0.0.0.0:${BRIDGE_PORT}"
  echo -e "  ${DIM}  T3 WS${RESET}  ${BRIDGE_T3_WS_URL}"
  echo -e "  ${DIM}  Unit${RESET}   ${BRIDGE_UNIT_PATH}"
  if [[ -n "$BRIDGE_ENV_FILE" ]]; then
    echo -e "  ${DIM}  Env${RESET}    ${BRIDGE_ENV_FILE}"
  fi
fi
echo ""

if [[ ! -t 0 ]] && [[ "$ASSUME_YES" != true ]]; then
  die "No TTY: re-run with ${BOLD}--yes${RESET} for non-interactive install"
fi

SERVICES_LABEL=""
if [[ "$INSTALL_MAIN" == true ]]; then
  SERVICES_LABEL="${SERVICE_NAME}.service"
fi
if [[ "$WITH_BRIDGE" == true && "$INSTALL_MAIN" == true ]]; then
  SERVICES_LABEL="${SERVICE_NAME}.service + ${BRIDGE_SERVICE_NAME}.service"
elif [[ "$WITH_BRIDGE" == true ]]; then
  SERVICES_LABEL="${BRIDGE_SERVICE_NAME}.service"
fi

if ! confirm "Install and start ${SERVICES_LABEL} now?"; then
  echo "Aborted."
  exit 1
fi

if [[ "$USER_SCOPE" == true ]]; then
  mkdir -p "${HOME}/.config/systemd/user"
  if [[ "$INSTALL_MAIN" == true ]]; then
    cp "$TMP_UNIT" "$UNIT_PATH"
  fi
  if [[ "$WITH_BRIDGE" == true ]]; then
    cp "$TMP_BRIDGE_UNIT" "$BRIDGE_UNIT_PATH"
  fi
  systemctl --user daemon-reload
  if [[ "$INSTALL_MAIN" == true ]]; then
    systemctl --user enable --now "${SERVICE_NAME}.service"
    ok "User service enabled and started"
  fi
  if [[ "$WITH_BRIDGE" == true ]]; then
    systemctl --user enable --now "${BRIDGE_SERVICE_NAME}.service"
    ok "Bridge user service enabled and started"
  fi
  warn "For start-on-boot without login, run once: ${BOLD}loginctl enable-linger ${USER_NAME}${RESET}"
else
  if [[ "$INSTALL_MAIN" == true ]]; then
    sudo cp "$TMP_UNIT" "$UNIT_PATH"
  fi
  if [[ "$WITH_BRIDGE" == true ]]; then
    sudo cp "$TMP_BRIDGE_UNIT" "$BRIDGE_UNIT_PATH"
  fi
  sudo systemctl daemon-reload
  if [[ "$INSTALL_MAIN" == true ]]; then
    sudo systemctl enable --now "${SERVICE_NAME}.service"
    ok "System service enabled and started"
  fi
  if [[ "$WITH_BRIDGE" == true ]]; then
    sudo systemctl enable --now "${BRIDGE_SERVICE_NAME}.service"
    ok "Bridge system service enabled and started"
  fi
fi

# ── bridge-specific footer ───────────────────────────────────
if [[ "$WITH_BRIDGE" == true && "$INSTALL_MAIN" == true ]]; then
  step 6 "$TOTAL_STEPS" "Bridge service installed"
  echo ""
  echo -e "  ${CYAN}Status:${RESET}  systemctl $([[ "$USER_SCOPE" == true ]] && echo --user) status ${BRIDGE_SERVICE_NAME}.service"
  echo -e "  ${CYAN}Logs:${RESET}    journalctl $([[ "$USER_SCOPE" == true ]] && echo --user -u "${BRIDGE_SERVICE_NAME}.service" || echo -u "${BRIDGE_SERVICE_NAME}.service") -f"
  echo -e "  ${CYAN}Stop:${RESET}    systemctl $([[ "$USER_SCOPE" == true ]] && echo --user) stop ${BRIDGE_SERVICE_NAME}.service"
fi

# ── footer ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}Done.${RESET}"
echo ""
if [[ "$INSTALL_MAIN" == true ]]; then
  echo -e "  ${CYAN}Status:${RESET}  systemctl $([[ "$USER_SCOPE" == true ]] && echo --user) status ${SERVICE_NAME}.service"
  echo -e "  ${CYAN}Logs:${RESET}    journalctl $([[ "$USER_SCOPE" == true ]] && echo --user -u "${SERVICE_NAME}.service" || echo -u "${SERVICE_NAME}.service") -f"
  echo -e "  ${CYAN}Stop:${RESET}    systemctl $([[ "$USER_SCOPE" == true ]] && echo --user) stop ${SERVICE_NAME}.service"
  echo ""
  echo -e "  ${DIM}Open UI: http://127.0.0.1:${PORT}  (or your tailnet IP)${RESET}"
fi
if [[ "$WITH_BRIDGE" == true ]]; then
  if [[ "$INSTALL_MAIN" != true ]]; then
    echo -e "  ${CYAN}Status:${RESET}  systemctl $([[ "$USER_SCOPE" == true ]] && echo --user) status ${BRIDGE_SERVICE_NAME}.service"
    echo -e "  ${CYAN}Logs:${RESET}    journalctl $([[ "$USER_SCOPE" == true ]] && echo --user -u "${BRIDGE_SERVICE_NAME}.service" || echo -u "${BRIDGE_SERVICE_NAME}.service") -f"
    echo -e "  ${CYAN}Stop:${RESET}    systemctl $([[ "$USER_SCOPE" == true ]] && echo --user) stop ${BRIDGE_SERVICE_NAME}.service"
    echo ""
  fi
  echo -e "  ${DIM}Bridge:  http://127.0.0.1:${BRIDGE_PORT}${RESET}"
fi
echo ""
