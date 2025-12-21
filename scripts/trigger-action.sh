#!/usr/bin/env bash
set -euo pipefail

ACTION_ID=${1:-}
HOST=${HOST:-localhost:8080}
TOKEN=${API_TOKEN:-}

if [ -z "$TOKEN" ] && [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  . ".env"
  set +a
  TOKEN=${API_TOKEN:-}
fi

if [ -z "$ACTION_ID" ]; then
  echo "Usage: API_TOKEN=... $0 <actionId>" >&2
  exit 1
fi

if [ -z "$TOKEN" ]; then
  echo "API_TOKEN is required" >&2
  exit 1
fi

curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "http://$HOST/v1/actions/$ACTION_ID"
