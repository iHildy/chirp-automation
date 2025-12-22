#!/usr/bin/env bash
set -euo pipefail

ARTIFACTS_DIR=${ARTIFACTS_DIR:-/opt/chirp/data/artifacts}
ACTIONS_PATH=${ACTIONS_PATH:-/opt/chirp/config/actions.yaml}
SKIP_EMULATOR_START=${SKIP_EMULATOR_START:-false}

# budtmo/docker-android's Openbox/Xvfb stack relies on DISPLAY.
# Ensure it's always set for headless (noVNC) operation.
export DISPLAY=${DISPLAY:-:0}

# Avoid slow/fragile quickboot snapshot behavior on fresh volumes.
# Also disable audio + metrics prompts to reduce noise and potential future blocking.
# These defaults can be overridden by setting EMULATOR_ADDITIONAL_ARGS.
export EMULATOR_ADDITIONAL_ARGS="${EMULATOR_ADDITIONAL_ARGS:--no-snapshot-load -no-snapshot-save -no-boot-anim -no-audio -no-metrics}"

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" >&2
}

if ! mkdir -p "$ARTIFACTS_DIR" 2>/dev/null; then
  fallback="/home/androidusr/chirp-artifacts"
  log "WARNING: cannot create artifacts dir at $ARTIFACTS_DIR; falling back to $fallback"
  ARTIFACTS_DIR="$fallback"
  export ARTIFACTS_DIR
  mkdir -p "$ARTIFACTS_DIR"
fi

if [ ! -f "$ACTIONS_PATH" ]; then
  log "WARNING: actions config not found at $ACTIONS_PATH"
fi

start_emulator_if_enabled() {
  if [ "$SKIP_EMULATOR_START" = "true" ]; then
    log "SKIP_EMULATOR_START=true; skipping emulator startup"
    return 0
  fi

  # docker-android's CLI hard-fails when /dev/kvm is absent.
  if [ ! -e /dev/kvm ]; then
    log "WARNING: /dev/kvm not found inside container; emulator cannot start"
    log "- If this host supports KVM, run with --device /dev/kvm (and usually --privileged)"
    log "- If running inside another container/VM, you need nested virtualization and /dev/kvm passthrough"
    log "- Alternative: set SKIP_EMULATOR_START=true and provide ADB_CONNECT to an external emulator"
    return 0
  fi

  if [ -x /opt/docker-android/start.sh ]; then
    log "Starting emulator stack via /opt/docker-android/start.sh"
    /opt/docker-android/start.sh &
    return 0
  fi

  if [ -x /start.sh ]; then
    log "Starting emulator stack via /start.sh"
    /start.sh &
    return 0
  fi

  if ! command -v docker-android >/dev/null 2>&1; then
    log "WARNING: docker-android not found; API will still run"
    return 0
  fi

  log "Starting emulator components (DISPLAY=$DISPLAY)"

  # If the container previously crashed mid-boot, a stale X lock can prevent Xvfb.
  display_number="${DISPLAY#:}"
  display_number="${display_number%%.*}"
  x_lock="/tmp/.X${display_number}-lock"
  x_sock="/tmp/.X11-unix/X${display_number}"

  if [ -e "$x_lock" ] && [ ! -S "$x_sock" ]; then
    log "Removing stale X lock: $x_lock"
    rm -f "$x_lock" || true
  fi

  docker-android start display_screen &

  # Best-effort wait until the X socket exists before launching Openbox.
  for _ in $(seq 1 40); do
    if [ -S "$x_sock" ]; then
      break
    fi
    sleep 0.25
  done

  if [ ! -S "$x_sock" ]; then
    log "WARNING: X socket not ready at $x_sock; Openbox may fail to start"
  fi

  docker-android start display_wm &
  docker-android start device &
  docker-android start port_forwarder &

  if [ "${WEB_VNC:-}" = "true" ]; then
    docker-android start vnc_server &
    docker-android start vnc_web &
  fi
}

start_emulator_if_enabled

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
