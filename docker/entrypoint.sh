#!/usr/bin/env bash
set -euo pipefail

ARTIFACTS_DIR=${ARTIFACTS_DIR:-/opt/chirp/data/artifacts}
ACTIONS_PATH=${ACTIONS_PATH:-/opt/chirp/config/actions.yaml}

mkdir -p "$ARTIFACTS_DIR"

if [ ! -f "$ACTIONS_PATH" ]; then
  echo "WARNING: actions config not found at $ACTIONS_PATH" >&2
fi

if [ -x /opt/docker-android/start.sh ]; then
  /opt/docker-android/start.sh &
elif [ -x /start.sh ]; then
  /start.sh &
else
  echo "WARNING: emulator start script not found; API will still run" >&2
fi

if command -v adb >/dev/null 2>&1; then
  adb start-server || true
fi

exec node /opt/chirp/dist/server.js
