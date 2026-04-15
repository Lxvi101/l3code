#!/usr/bin/env bash
# Install T3 Code (and optionally THE RELAY) as systemd services.
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

# Relay defaults
WITH_RELAY=false
RELAY_ONLY=false
RELAY_PORT="${RELAY_SERVER_PORT:-4400}"
RELAY_SERVICE_NAME="${T3CODE_RELAY_SERVICE_NAME:-t3code-relay}"

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

THE RELAY options:
  --with-relay            Also install THE RELAY as a companion service
  --relay-only            Build/install/start only THE RELAY service
  --relay-port N          Relay server port (default: 4400, or \$RELAY_SERVER_PORT)
  --relay-name NAME       Relay unit name (default: t3code-relay, or \$T3CODE_RELAY_SERVICE_NAME)

Env: \$T3CODE_REPO, \$T3CODE_PORT, \$T3CODE_HOST, \$T3CODE_SERVICE_NAME, \$T3CODE_SERVICE_PATH
     \$RELAY_SERVER_PORT, \$T3CODE_RELAY_SERVICE_NAME

Examples:
  $(basename "$0")
  $(basename "$0") --repo /home/levi/t3code/t3code --yes
  $(basename "$0") --user --skip-build
  $(basename "$0") --with-relay
  $(basename "$0") --relay-only --relay-port 4400
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
    --with-relay) WITH_RELAY=true; shift ;;
    --relay-only)
      RELAY_ONLY=true
      WITH_RELAY=true
      INSTALL_MAIN=false
      shift
      ;;
    --relay-port)
      RELAY_PORT="${2:-}"
      shift 2
      ;;
    --relay-name)
      RELAY_SERVICE_NAME="${2:-}"
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
if [[ "$WITH_RELAY" == true && "$INSTALL_MAIN" == true ]]; then
  TOTAL_STEPS=6
fi

# ── preflight ─────────────────────────────────────────────────
step 1 "$TOTAL_STEPS" "Checking repository"
[[ -f "${REPO_ROOT}/apps/server/package.json" ]] ||
  die "Not a T3 Code repo: ${REPO_ROOT} (missing apps/server/package.json)"

ok "Repository: ${BOLD}${REPO_ROOT}${RESET}"

if [[ "$WITH_RELAY" == true ]]; then
  [[ -f "${REPO_ROOT}/apps/chat-relay/package.json" ]] ||
    die "THE RELAY not found: ${REPO_ROOT} (missing apps/chat-relay/package.json)"
  ok "THE RELAY: ${BOLD}${REPO_ROOT}/apps/chat-relay${RESET}"
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

# ── build ─────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" != true ]]; then
  step 2 "$TOTAL_STEPS" "Installing dependencies (bun install)"
  if [[ "$DRY_RUN" == true ]]; then
    info "Would run: (cd \"${REPO_ROOT}\" && bun install)"
  else
    (cd "$REPO_ROOT" && bun install)
    ok "Dependencies installed"
  fi

  if [[ "$RELAY_ONLY" == true ]]; then
    step 3 "$TOTAL_STEPS" "Building THE RELAY"
  else
    step 3 "$TOTAL_STEPS" "Building"
  fi
  if [[ "$DRY_RUN" == true ]]; then
    if [[ "$INSTALL_MAIN" == true ]]; then
      info "Would run: (cd \"${REPO_ROOT}\" && bun run build)"
    fi
    if [[ "$WITH_RELAY" == true ]]; then
      info "Would run: (cd \"${REPO_ROOT}/apps/chat-relay\" && bun run build)"
    fi
  else
    if [[ "$INSTALL_MAIN" == true ]]; then
      (cd "$REPO_ROOT" && bun run build)
      ok "Build finished"
    fi
    if [[ "$WITH_RELAY" == true ]]; then
      (cd "${REPO_ROOT}/apps/chat-relay" && bun run build)
      ok "THE RELAY built"
    fi
  fi
else
  step 2 "$TOTAL_STEPS" "Skipping install & build (--skip-build)"
  if [[ "$INSTALL_MAIN" == true ]]; then
    warn "Ensure you already ran: bun install && bun run build"
  else
    warn "Ensure you already ran: bun install"
  fi
  if [[ "$WITH_RELAY" == true ]]; then
    warn "And for THE RELAY: (cd apps/chat-relay && bun run build)"
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
  trap 'rm -f "$TMP_UNIT" "${TMP_RELAY_UNIT:-}"' EXIT
  render_unit >"$TMP_UNIT"
else
  trap 'rm -f "${TMP_RELAY_UNIT:-}"' EXIT
fi

# Relay unit
RELAY_UNIT_PATH=""
TMP_RELAY_UNIT=""
if [[ "$WITH_RELAY" == true ]]; then
  if [[ "$USER_SCOPE" == true ]]; then
    RELAY_UNIT_PATH="${HOME}/.config/systemd/user/${RELAY_SERVICE_NAME}.service"
  else
    RELAY_UNIT_PATH="/etc/systemd/system/${RELAY_SERVICE_NAME}.service"
  fi

  render_relay_unit() {
    if [[ "$USER_SCOPE" == true ]]; then
      local unit_dependencies=""
      if [[ "$RELAY_ONLY" != true ]]; then
        unit_dependencies="${SERVICE_NAME}.service"
      fi
      cat <<UNIT
[Unit]
Description=THE RELAY — T3 Code Chat Relay (agent-to-agent ping-pong)
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
Environment="RELAY_SERVER_PORT=${RELAY_PORT}"
ExecStart=${BUN_PATH} run --cwd apps/chat-relay start
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
UNIT
    else
      local unit_dependencies=""
      if [[ "$RELAY_ONLY" != true ]]; then
        unit_dependencies="${SERVICE_NAME}.service"
      fi
      cat <<UNIT
[Unit]
Description=THE RELAY — T3 Code Chat Relay (agent-to-agent ping-pong)
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
Environment="RELAY_SERVER_PORT=${RELAY_PORT}"
ExecStart=${BUN_PATH} run --cwd apps/chat-relay start
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
    fi
  }

  TMP_RELAY_UNIT="$(mktemp)"
  render_relay_unit >"$TMP_RELAY_UNIT"
fi

if [[ "$DRY_RUN" == true ]]; then
  if [[ "$INSTALL_MAIN" == true ]]; then
    echo ""
    echo -e "${DIM}--- ${SERVICE_NAME}.service (preview) ---${RESET}"
    sed 's/^/  /' "$TMP_UNIT"
    echo -e "${DIM}--- end ---${RESET}"
  fi
  if [[ "$WITH_RELAY" == true ]]; then
    echo ""
    echo -e "${DIM}--- ${RELAY_SERVICE_NAME}.service (preview) ---${RESET}"
    sed 's/^/  /' "$TMP_RELAY_UNIT"
    echo -e "${DIM}--- end ---${RESET}"
  fi
else
  if [[ "$INSTALL_MAIN" == true ]]; then
    ok "Unit file prepared (${UNIT_PATH})"
  fi
  if [[ "$WITH_RELAY" == true ]]; then
    ok "Relay unit file prepared (${RELAY_UNIT_PATH})"
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
    if [[ "$WITH_RELAY" == true ]]; then
      info "Would: cp relay unit → ${RELAY_UNIT_PATH}"
    fi
    info "Would: systemctl --user daemon-reload"
    if [[ "$INSTALL_MAIN" == true ]]; then
      info "Would: systemctl --user enable --now ${SERVICE_NAME}.service"
    fi
    if [[ "$WITH_RELAY" == true ]]; then
      info "Would: systemctl --user enable --now ${RELAY_SERVICE_NAME}.service"
    fi
  else
    if [[ "$INSTALL_MAIN" == true ]]; then
      info "Would: sudo cp → ${UNIT_PATH}"
    fi
    if [[ "$WITH_RELAY" == true ]]; then
      info "Would: sudo cp → ${RELAY_UNIT_PATH}"
    fi
    info "Would: sudo systemctl daemon-reload"
    if [[ "$INSTALL_MAIN" == true ]]; then
      info "Would: sudo systemctl enable --now ${SERVICE_NAME}.service"
    fi
    if [[ "$WITH_RELAY" == true ]]; then
      info "Would: sudo systemctl enable --now ${RELAY_SERVICE_NAME}.service"
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
if [[ "$WITH_RELAY" == true ]]; then
  echo ""
  echo -e "  ${DIM}THE RELAY${RESET}"
  echo -e "  ${DIM}  Port${RESET}   ${RELAY_PORT}"
  echo -e "  ${DIM}  Unit${RESET}   ${RELAY_UNIT_PATH}"
fi
echo ""

if [[ ! -t 0 ]] && [[ "$ASSUME_YES" != true ]]; then
  die "No TTY: re-run with ${BOLD}--yes${RESET} for non-interactive install"
fi

SERVICES_LABEL=""
if [[ "$INSTALL_MAIN" == true ]]; then
  SERVICES_LABEL="${SERVICE_NAME}.service"
fi
if [[ "$WITH_RELAY" == true && "$INSTALL_MAIN" == true ]]; then
  SERVICES_LABEL="${SERVICE_NAME}.service + ${RELAY_SERVICE_NAME}.service"
elif [[ "$WITH_RELAY" == true ]]; then
  SERVICES_LABEL="${RELAY_SERVICE_NAME}.service"
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
  if [[ "$WITH_RELAY" == true ]]; then
    cp "$TMP_RELAY_UNIT" "$RELAY_UNIT_PATH"
  fi
  systemctl --user daemon-reload
  if [[ "$INSTALL_MAIN" == true ]]; then
    systemctl --user enable --now "${SERVICE_NAME}.service"
    ok "User service enabled and started"
  fi
  if [[ "$WITH_RELAY" == true ]]; then
    systemctl --user enable --now "${RELAY_SERVICE_NAME}.service"
    ok "THE RELAY user service enabled and started"
  fi
  warn "For start-on-boot without login, run once: ${BOLD}loginctl enable-linger ${USER_NAME}${RESET}"
else
  if [[ "$INSTALL_MAIN" == true ]]; then
    sudo cp "$TMP_UNIT" "$UNIT_PATH"
  fi
  if [[ "$WITH_RELAY" == true ]]; then
    sudo cp "$TMP_RELAY_UNIT" "$RELAY_UNIT_PATH"
  fi
  sudo systemctl daemon-reload
  if [[ "$INSTALL_MAIN" == true ]]; then
    sudo systemctl enable --now "${SERVICE_NAME}.service"
    ok "System service enabled and started"
  fi
  if [[ "$WITH_RELAY" == true ]]; then
    sudo systemctl enable --now "${RELAY_SERVICE_NAME}.service"
    ok "THE RELAY system service enabled and started"
  fi
fi

# ── relay-specific footer ────────────────────────────────────
if [[ "$WITH_RELAY" == true && "$INSTALL_MAIN" == true ]]; then
  step 6 "$TOTAL_STEPS" "THE RELAY installed"
  echo ""
  echo -e "  ${CYAN}Status:${RESET}  systemctl $([[ "$USER_SCOPE" == true ]] && echo --user) status ${RELAY_SERVICE_NAME}.service"
  echo -e "  ${CYAN}Logs:${RESET}    journalctl $([[ "$USER_SCOPE" == true ]] && echo --user -u "${RELAY_SERVICE_NAME}.service" || echo -u "${RELAY_SERVICE_NAME}.service") -f"
  echo -e "  ${CYAN}Stop:${RESET}    systemctl $([[ "$USER_SCOPE" == true ]] && echo --user) stop ${RELAY_SERVICE_NAME}.service"
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
if [[ "$WITH_RELAY" == true ]]; then
  if [[ "$INSTALL_MAIN" != true ]]; then
    echo -e "  ${CYAN}Status:${RESET}  systemctl $([[ "$USER_SCOPE" == true ]] && echo --user) status ${RELAY_SERVICE_NAME}.service"
    echo -e "  ${CYAN}Logs:${RESET}    journalctl $([[ "$USER_SCOPE" == true ]] && echo --user -u "${RELAY_SERVICE_NAME}.service" || echo -u "${RELAY_SERVICE_NAME}.service") -f"
    echo -e "  ${CYAN}Stop:${RESET}    systemctl $([[ "$USER_SCOPE" == true ]] && echo --user) stop ${RELAY_SERVICE_NAME}.service"
    echo ""
  fi
  echo -e "  ${DIM}THE RELAY: http://127.0.0.1:${RELAY_PORT}${RESET}"
fi
echo ""
