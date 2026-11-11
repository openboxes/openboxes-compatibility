#!/usr/bin/env bash
# Wait until a URL answers HTTP 200, or give up after a timeout.
#
#   wait-ready.sh <url> <timeout-seconds> [container-id]
#
# Prints the number of seconds it took on success. Exit 0 when ready, 1 on
# timeout, 3 when the given container stopped (no point waiting further).
# Readiness is the login page, never a health endpoint: health paths moved
# between Spring Boot versions and are checked separately.
set -euo pipefail

url=${1:?usage: wait-ready.sh <url> <timeout-seconds> [container-id]}
timeout=${2:?usage: wait-ready.sh <url> <timeout-seconds> [container-id]}
container=${3:-}

start=$(date +%s)
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)
  now=$(date +%s)
  elapsed=$((now - start))
  if [[ "$code" == "200" ]]; then
    echo "$elapsed"
    exit 0
  fi
  if [[ -n "$container" ]]; then
    state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$container" 2>/dev/null ||
      echo "missing -")
    if [[ "$state" != running* ]]; then
      echo "app container stopped after ${elapsed}s (state: $state)" >&2
      exit 3
    fi
  fi
  if ((elapsed >= timeout)); then
    echo "login page not 200 within ${timeout}s (last HTTP status: ${code:-none})" >&2
    exit 1
  fi
  sleep 5
done
