#!/usr/bin/env bash
#
# Start the benchmarker daemon with operator-local config (config/local.json).
# Sources .env for secrets and reads Buildkite token from ~/.buildkite/token.
#
# Usage:
#   ./scripts/start-local.sh [--daemonize] [extra benchmarker-queue start flags...]
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f config/local.json ]]; then
  echo "Error: config/local.json not found. Copy config/smoke-full.json and add your SSH/VM values." >&2
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

# Basic auth is only for the local dev ES. When an API key is set (serverless),
# skip it entirely — the ES client applies basic auth last and would otherwise
# clobber the API key (see src/cli.ts createEsClient).
if [[ -z "${ELASTICSEARCH_API_KEY:-}" ]]; then
  if [[ -z "${ELASTIC_PASSWORD:-}" && -f .env.docker ]]; then
    set -a
    # shellcheck source=/dev/null
    source .env.docker
    set +a
  fi

  if [[ -n "${ELASTIC_PASSWORD:-}" && -z "${ELASTICSEARCH_PASSWORD:-}" ]]; then
    export ELASTICSEARCH_USERNAME="${ELASTICSEARCH_USERNAME:-elastic}"
    export ELASTICSEARCH_PASSWORD="${ELASTIC_PASSWORD}"
  fi
fi

# Boot-time log tail-truncate. launchd does NOT rotate StandardOutPath, so the
# daemon log would grow unbounded across KeepAlive respawns. Keep the last ~5MB
# whenever the file exceeds ~50MB. Runs once per launch (each launchd respawn),
# which is enough because launchd restarts the daemon on any crash/reboot.
LOG_FILE="${BENCHMARKER_DAEMON_LOG:-${ROOT}/.smoke-logs/daemon.log}"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -f "$LOG_FILE" ]]; then
  LOG_SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
  if [[ "${LOG_SIZE:-0}" -gt 52428800 ]]; then
    TAIL_TMP="${LOG_FILE}.tail"
    tail -c 5242880 "$LOG_FILE" > "$TAIL_TMP" 2>/dev/null && mv "$TAIL_TMP" "$LOG_FILE"
    echo "[start-local] truncated $LOG_FILE (was ${LOG_SIZE} bytes, kept last ~5MB)" >> "$LOG_FILE"
  fi
fi

export BENCHMARKER_CONFIG="${ROOT}/config/local.json"

if [[ -z "${BUILDKITE_API_TOKEN:-}" && -f "${HOME}/.buildkite/token" ]]; then
  export BUILDKITE_API_TOKEN
  BUILDKITE_API_TOKEN="$(cat "${HOME}/.buildkite/token")"
fi

CLI="${BENCHMARKER_QUEUE_BIN:-/tmp/benchmarker-queue}"
ln -sf "${ROOT}/dist/cli.js" "${CLI}"

DEFAULT_FLAGS=(
  --config "${ROOT}/config/local.json"
  --stage2
  --stage3
  --ci-evals
  --poll-interval 10000
)

exec "${CLI}" start "${DEFAULT_FLAGS[@]}" "$@"
