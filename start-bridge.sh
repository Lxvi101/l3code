#!/usr/bin/env bash
# Start the Mythos Bridge (apps/bridge)
# Requires the T3 Code server to already be running on ws://localhost:3773

set -euo pipefail
cd "$(dirname "$0")"

# Load .env if it exists
if [ -f apps/bridge/.env ]; then
  set -a
  source apps/bridge/.env
  set +a
fi

# Build the UI if dist is missing or --build is passed
if [ ! -d apps/bridge/ui/dist ] || [[ " $* " == *" --build "* ]]; then
  echo "Building bridge UI…"
  (cd apps/bridge && bun run build:ui)
fi

echo "Starting bridge → http://localhost:${BRIDGE_PORT:-3100}"
exec bun run apps/bridge/src/main.ts "$@"
