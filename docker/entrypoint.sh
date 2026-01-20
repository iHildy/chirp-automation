#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# ROOT-ONLY SETUP (runs first when container starts as root)
# =============================================================================
if [ "$(id -u)" = "0" ]; then
  # Fix KVM permissions for androidusr (UID 1300, GID 1301)
  # This fixes the "sudo: unknown user root" bug in budtmo/docker-android
  if [ -e /dev/kvm ]; then
    chown 1300:1301 /dev/kvm 2>/dev/null || true
    chmod 660 /dev/kvm 2>/dev/null || true
  fi

  # Ensure androidusr owns necessary directories (in case volume was created as root)
  chown -R 1300:1301 /home/androidusr 2>/dev/null || true
  chown -R 1300:1301 /opt/chirp 2>/dev/null || true

  # Re-exec this script as androidusr using gosu
  exec gosu androidusr "$0" "$@"
fi

# =============================================================================
# ANDROIDUSR CONTEXT (everything below runs as androidusr)
# =============================================================================

ARTIFACTS_DIR=${ARTIFACTS_DIR:-/opt/chirp/data/artifacts}
ACTIONS_PATH=${ACTIONS_PATH:-/opt/chirp/config/actions.yaml}
SKIP_EMULATOR_START=${SKIP_EMULATOR_START:-false}

# budtmo/docker-android's Openbox/Xvfb stack relies on DISPLAY.
# Ensure it's always set for headless (noVNC) operation.
export DISPLAY=${DISPLAY:-:0}

# Avoid slow/fragile quickboot snapshot behavior on fresh volumes.
# Also disable audio + metrics prompts to reduce noise and potential future blocking.
# These defaults can be overridden by setting EMULATOR_ADDITIONAL_ARGS.
export EMULATOR_ADDITIONAL_ARGS="${EMULATOR_ADDITIONAL_ARGS:--no-snapshot-load -no-snapshot-save -no-boot-anim -no-audio -no-metrics -gpu swiftshader_indirect -memory 2048}"

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" >&2
}

# Clean up stale Android emulator lock files that persist after container restart.
# The emulator uses .lock files to prevent multiple instances, but these aren't
# cleaned up when the container is stopped abruptly (docker stop/kill/crash).
# This causes "Running multiple emulators with the same AVD" errors on restart.
cleanup_stale_emulator_locks() {
  local avd_home="${ANDROID_AVD_HOME:-/home/androidusr/.android/avd}"
  local emulator_home="/home/androidusr/emulator"
  
  # Check if any emulator process is actually running - if so, don't touch locks
  if pgrep -f "qemu-system" >/dev/null 2>&1 || pgrep -f "emulator" >/dev/null 2>&1; then
    log "Emulator process detected; skipping lock cleanup"
    return 0
  fi
  
  local lock_count=0
  
  # Clean locks in the AVD directory (e.g., ~/.android/avd/*.avd/)
  if [ -d "$avd_home" ]; then
    for avd_dir in "$avd_home"/*.avd; do
      if [ -d "$avd_dir" ]; then
        for lock_file in "$avd_dir"/*.lock; do
          if [ -f "$lock_file" ]; then
            log "Removing stale AVD lock: $lock_file"
            rm -f "$lock_file" || true
            lock_count=$((lock_count + 1))
          fi
        done
      fi
    done
  fi
  
  # Clean locks in the emulator data directory (used by docker-android)
  if [ -d "$emulator_home" ]; then
    for lock_file in "$emulator_home"/*.lock; do
      if [ -f "$lock_file" ]; then
        log "Removing stale emulator lock: $lock_file"
        rm -f "$lock_file" || true
        lock_count=$((lock_count + 1))
      fi
    done
  fi
  
  # Also clean the multiinstance.lock in the AVD root if present
  local multiinstance_lock="$avd_home/multiinstance.lock"
  if [ -f "$multiinstance_lock" ]; then
    log "Removing stale multiinstance lock: $multiinstance_lock"
    rm -f "$multiinstance_lock" || true
    lock_count=$((lock_count + 1))
  fi
  
  # Clean any hardware-qemu.ini.lock files that might be in alternate locations
  for lock_file in /home/androidusr/.android/*.lock /home/androidusr/*.lock; do
    if [ -f "$lock_file" ]; then
      log "Removing stale lock: $lock_file"
      rm -f "$lock_file" || true
      lock_count=$((lock_count + 1))
    fi
  done
  
  if [ "$lock_count" -gt 0 ]; then
    log "Cleaned up $lock_count stale emulator lock file(s)"
  fi
}

# =============================================================================
# EMULATOR WATCHDOG
# Monitors emulator process health and restarts if it dies unexpectedly.
# Runs as a background process alongside the main Node.js server.
# =============================================================================
emulator_watchdog() {
  local initial_delay=120
  local check_interval=30
  local restart_cooldown=60
  local last_restart=0

  log "WATCHDOG: Starting emulator health monitor (initial delay: ${initial_delay}s)"
  sleep "$initial_delay"

  while true; do
    if [ "$SKIP_EMULATOR_START" != "true" ] && [ -e /dev/kvm ]; then
      # Check if qemu-system (the actual emulator process) is running
      if ! pgrep -f "qemu-system" >/dev/null 2>&1; then
        local now
        now=$(date +%s)
        local elapsed=$((now - last_restart))

        if [ "$elapsed" -ge "$restart_cooldown" ]; then
          log "WATCHDOG: Emulator process not found, attempting restart..."
          cleanup_stale_emulator_locks

          # Restart emulator using the best available method
          if [ -x /opt/docker-android/start.sh ]; then
            log "WATCHDOG: Restarting via /opt/docker-android/start.sh"
            /opt/docker-android/start.sh &
          elif [ -x /start.sh ]; then
            log "WATCHDOG: Restarting via /start.sh"
            /start.sh &
          elif command -v docker-android >/dev/null 2>&1; then
            log "WATCHDOG: Restarting via docker-android CLI"
            docker-android start display_screen &
            sleep 2
            docker-android start display_wm &
            docker-android start device &
            docker-android start port_forwarder &
            if [ "${WEB_VNC:-}" = "true" ]; then
              docker-android start vnc_server &
              docker-android start vnc_web &
            fi
          else
            log "WATCHDOG: No restart method available"
          fi

          last_restart=$now
        else
          log "WATCHDOG: Emulator down but in cooldown (${elapsed}s < ${restart_cooldown}s)"
        fi
      fi
    fi
    sleep "$check_interval"
  done
}

if ! mkdir -p "$ARTIFACTS_DIR" 2>/dev/null; then
  fallback="/home/androidusr/chirp-artifacts"
  log "WARNING: cannot create artifacts dir at $ARTIFACTS_DIR; falling back to $fallback"
  ARTIFACTS_DIR="$fallback"
  export ARTIFACTS_DIR
  mkdir -p "$ARTIFACTS_DIR"
fi

DEFAULT_ACTIONS_PATH="/opt/chirp-default/config/actions.yaml"

if [ ! -f "$ACTIONS_PATH" ] && [ -f "$DEFAULT_ACTIONS_PATH" ]; then
  log "WARNING: actions config not found at $ACTIONS_PATH; using bundled defaults at $DEFAULT_ACTIONS_PATH"
  ACTIONS_PATH="$DEFAULT_ACTIONS_PATH"
  export ACTIONS_PATH
fi

if [ ! -f "$ACTIONS_PATH" ]; then
  log "WARNING: actions config not found at $ACTIONS_PATH"
fi

start_emulator_if_enabled() {
  if [ "$SKIP_EMULATOR_START" = "true" ]; then
    log "SKIP_EMULATOR_START=true; skipping emulator startup"
    return 0
  fi

  # Clean up any stale lock files from previous container runs
  cleanup_stale_emulator_locks

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

# Start emulator watchdog in background (monitors and restarts emulator if it dies)
if [ "$SKIP_EMULATOR_START" != "true" ]; then
  emulator_watchdog &
  WATCHDOG_PID=$!
  log "WATCHDOG: Started with PID $WATCHDOG_PID"
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
