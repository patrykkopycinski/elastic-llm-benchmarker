#!/usr/bin/env bash
#
# launchd entrypoint for the benchmarker dashboard / REST API (queue-server).
#
# The daemon (run-daemon.sh) does NOT serve the dashboard — the API server is a
# separate process. This wrapper supervises it the same way: launchd starts
# with a bare environment and no login shell, so we restore the newest
# nvm-managed node on PATH, source .env for the (serverless) ES credentials,
# do a boot-time log tail-truncate, then exec the queue-server via tsx.
#
# Port defaults to 3200 (avoid 3100 — patryks-treadmill). Override with
# BENCHMARKER_API_PORT.
#
# Install the LaunchAgent:
#   ./scripts/install-launchd.sh dashboard
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Newest nvm node so `npx`/node resolve under launchd's bare PATH.
NODE_BIN="$(ls -d "${HOME}"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [[ -n "${NODE_BIN}" ]]; then
  export PATH="${NODE_BIN}:${PATH}"
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

export PORT="${BENCHMARKER_API_PORT:-3200}"
export SKILL_DEV_PLUGIN_DIR="${SKILL_DEV_PLUGIN_DIR:-${HOME}/Projects/agent-builder-skill-dev-cursor-plugin}"

# Boot-time log tail-truncate. launchd does NOT rotate StandardOutPath, so the
# dashboard log would grow unbounded across KeepAlive respawns. Keep the last
# ~5MB whenever the file exceeds ~50MB (runs once per launch).
LOG_FILE="${ROOT}/.smoke-logs/dashboard.log"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -f "$LOG_FILE" ]]; then
  LOG_SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
  if [[ "${LOG_SIZE:-0}" -gt 52428800 ]]; then
    TAIL_TMP="${LOG_FILE}.tail"
    tail -c 5242880 "$LOG_FILE" > "$TAIL_TMP" 2>/dev/null && mv "$TAIL_TMP" "$LOG_FILE"
    echo "[run-dashboard] truncated $LOG_FILE (was ${LOG_SIZE} bytes, kept last ~5MB)" >> "$LOG_FILE"
  fi
fi

# Run the prebuilt dist entry (tsup builds src/api/queue-server.ts). Running
# built JS avoids tsx JIT-compiling the whole import graph on every launchd
# respawn — under launchd's Background ProcessType the JIT compile is heavily
# I/O-throttled and delays the port bind by tens of seconds. Build once if the
# dist entry is missing (fresh checkout).
DIST_ENTRY="${ROOT}/dist/api/queue-server.js"
if [[ ! -f "$DIST_ENTRY" ]]; then
  echo "[run-dashboard] $DIST_ENTRY missing — building..."
  npm run build
fi

exec node "$DIST_ENTRY"
