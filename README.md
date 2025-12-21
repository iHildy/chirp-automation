# Chirp UI Automation Container

Self-hosted Android emulator + REST API for automating the Chirp app. The emulator stays hot and logged in; Home Assistant can trigger actions via HTTP.

## Prerequisites

- Linux x86_64 host with virtualization enabled in BIOS/UEFI
- KVM kernel modules loaded and `/dev/kvm` available
- Docker (and docker-compose plugin)

Example host packages:

```
sudo apt-get install -y qemu-kvm
```

## Quick start

1. Set an API token:

```
export API_TOKEN="replace-me"
```

2. Build and start:

```
docker compose up --build
```

3. Confirm health:

```
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:8080/v1/health
```

## First-run setup (manual)

1. Open the noVNC UI at `http://localhost:6080`.
2. Install Chirp (Play Store or sideload APK).
3. Log in once; emulator data is persisted to `./data` and `avd-data`.
4. Restart the container to confirm Chirp stays logged in.

## macOS dev (external emulator)

macOS cannot use KVM, so run the Android emulator on the host (Android Studio) and connect the container via ADB over TCP.

```
export ADB_CONNECT="host.docker.internal:5555"
export SKIP_EMULATOR_START="true"
docker compose up --build
```

If your emulator listens on a different port, update both values accordingly.

## Actions configuration

Edit `config/actions.yaml` to add or update actions. Each action is a list of steps (tap selectors preferred, coordinates as fallback).

Supported step types:

- `ensure_emulator_ready`
- `wake_and_unlock`
- `launch_app`
- `ensure_app_open` (supports `delayMsIfOpen` and `delayMsIfLaunch`)
- `tap_selector`
- `tap_coordinates`
- `wait_for_text`
- `wait_for_selector`
- `wait_for_any_selector`
- `sleep`
- `input_text`
- `keyevent`
- `retry`
- `repeat`

Selectors match against UIAutomator fields: `text`, `resourceId`, `contentDesc`, and their `*Contains` variants.

## REST API

All endpoints require `Authorization: Bearer <token>`.

- `POST /v1/actions/:actionId`
- `GET /v1/health`
- `GET /v1/debug/screenshot`
- `GET /v1/debug/state`

Example:

```
curl -X POST \
  -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:8080/v1/actions/open_garage
```

## Local trigger command

```
API_TOKEN="replace-me" ./scripts/trigger-action.sh tap_parking_garage_gate
```

## Home Assistant example

```
rest_command:
  chirp_open_garage:
    url: "http://<host>:8080/v1/actions/open_garage"
    method: POST
    headers:
      Authorization: "Bearer <token>"
```

## Notes

- If Chirp is ARM-only or uses device integrity checks, it may not run on x86 emulators.
- UI updates can break selectors. Use `/v1/debug/screenshot` and the artifacts in `data/artifacts` to update selectors quickly.
- For security, keep this service on your LAN or behind a reverse proxy.
