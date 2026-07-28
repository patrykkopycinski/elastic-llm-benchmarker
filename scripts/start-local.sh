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

# Non-login/non-interactive SSH invocations (e.g. `ssh host "cmd"`, launchd with a
# minimal environment) don't source /etc/zprofile, so Homebrew's bin dirs may be
# missing from PATH even though brew-installed tools like tmux/cloudflared exist.
# This has previously caused Stage 2 batch evals to fail immediately with
# "tmux is required but not found" despite tmux being installed — the daemon just
# couldn't see it. Make sure both Intel (/usr/local) and Apple Silicon
# (/opt/homebrew) Homebrew prefixes are always on PATH before we do anything else.
for brew_bin in /usr/local/bin /opt/homebrew/bin; do
  if [[ -d "$brew_bin" && ":$PATH:" != *":$brew_bin:"* ]]; then
    export PATH="$brew_bin:$PATH"
  fi
done

if [[ ! -f config/local.json ]]; then
  echo "Error: config/local.json not found. Copy config/smoke-full.json and add your SSH/VM values." >&2
  exit 1
fi

# Fail loudly and immediately if a binary Stage 2's batch runner depends on isn't
# reachable, instead of letting the daemon start "successfully" and then silently
# failing every Stage 2 batch eval with a buried stderr line hours later.
for required_bin in tmux; do
  if ! command -v "$required_bin" >/dev/null 2>&1; then
    echo "Error: required binary '$required_bin' not found on PATH (PATH=$PATH)." >&2
    echo "Stage 2 batch evals will fail immediately without it. Install via 'brew install $required_bin' or fix PATH." >&2
    exit 1
  fi
done

export BOOT_POLL_ATTEMPTS="${BOOT_POLL_ATTEMPTS:-1800}"

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

# Stage 2 batch runner: GCS snapshot creds + eval runtime from skill-dev plugin.
PLUGIN_DIR="${SKILL_DEV_PLUGIN_DIR:-$HOME/Projects/agent-builder-skill-dev-cursor-plugin}"
if [[ -f "${PLUGIN_DIR}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${PLUGIN_DIR}/.env"
  set +a
fi

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
