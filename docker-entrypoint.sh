#!/bin/sh
# Container entrypoint for the elastic-llm-benchmarker.
#
# Runs two long-lived processes that share Elasticsearch-backed state:
#   1. The Queue API (dist/api/queue-server.js) — HTTP dashboard + REST surface.
#   2. The daemon (dist/cli.js start ...) — scheduler + workers + discovery.
#
# The daemon does not serve HTTP; the API does not run the pipeline. Together
# they form the full autonomous benchmarker. The API is backgrounded so it
# does not become PID 1; the daemon is `exec`'d so it owns signal handling
# (SIGTERM graceful shutdown) and the container lifecycle.
set -e

API_PORT="${PORT:-3200}"
CONFIG_PATH="${BENCHMARKER_CONFIG:-config/gcp.json}"

# ---- Queue API (background) -------------------------------------------------
# Disabled when BENCHMARKER_API_ENABLED=false (e.g. sidecar that only needs
# the daemon). Defaults to enabled.
if [ "${BENCHMARKER_API_ENABLED:-true}" != "false" ]; then
  PORT="$API_PORT" node dist/api/queue-server.js &
  API_PID=$!
  echo "[entrypoint] Queue API started on port ${API_PORT} (pid ${API_PID})"
fi

# ---- Daemon (PID 1) ---------------------------------------------------------
# Flags are intentionally explicit: discovery + stage2 + stage3 + api.
# --ci-evals is NOT passed by default; Tier-1 local evals run in-VPC when
# stage2 is enabled without buildkite.onDemand. Override via
# BENCHMARKER_DAEMON_FLAGS for operator-specific runs.
DEFAULT_FLAGS="start --config ${CONFIG_PATH} --discovery --stage2 --stage3"
DAEMON_FLAGS="${BENCHMARKER_DAEMON_FLAGS:-$DEFAULT_FLAGS}"

echo "[entrypoint] Starting daemon: node dist/cli.js ${DAEMON_FLAGS}"
exec node dist/cli.js ${DAEMON_FLAGS}
