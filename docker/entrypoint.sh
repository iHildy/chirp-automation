#!/usr/bin/env bash
set -euo pipefail

ARTIFACTS_DIR=${ARTIFACTS_DIR:-/opt/chirp/data/artifacts}
ACTIONS_PATH=${ACTIONS_PATH:-/opt/chirp/config/actions.yaml}
SKIP_EMULATOR_START=${SKIP_EMULATOR_START:-false}

mkdir -p "$ARTIFACTS_DIR"

if [ ! -f "$ACTIONS_PATH" ]; then
  echo "WARNING: actions config not found at $ACTIONS_PATH" >&2
fi

if [ "$SKIP_EMULATOR_START" != "true" ]; then
  if [ -x /opt/docker-android/start.sh ]; then
    /opt/docker-android/start.sh &
  elif [ -x /start.sh ]; then
    /start.sh &
  elif command -v docker-android >/dev/null 2>&1; then
    docker-android start display_screen &
    docker-android start display_wm &
    docker-android start device &
    docker-android start port_forwarder &

    if [ "${WEB_VNC:-}" = "true" ]; then
      docker-android start vnc_server &
      docker-android start vnc_web &
    fi
  else
    echo "WARNING: emulator start script not found; API will still run" >&2
  fi
fi

if command -v adb >/dev/null 2>&1; then
  adb start-server || true
  if [ -n "${ADB_CONNECT:-}" ]; then
    if [ "${ADB_SERIAL:-}" = "emulator-5554" ]; then
      export ADB_SERIAL="${ADB_CONNECT%%,*}"
    fi
    for endpoint in ${ADB_CONNECT//,/ }; do
      if [ -n "$endpoint" ]; then
        adb connect "$endpoint" || true
      fi
    done
  fi
fi

exec node /opt/chirp/dist/server.js
