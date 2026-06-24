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

if [[ -z "${BUILDKITE_API_TOKEN:-}" && -f "${HOME}/.buildkite/token" ]]; then
  export BUILDKITE_API_TOKEN
  BUILDKITE_API_TOKEN="$(cat "${HOME}/.buildkite/token")"
fi

CLI="${BENCHMARKER_QUEUE_BIN:-/tmp/benchmarker-queue}"
ln -sf "${ROOT}/dist/cli.js" "${CLI}"

DEFAULT_FLAGS=(
  --config config/local.json
  --stage2
  --stage3
  --ci-evals
  --full-eval
  --poll-interval 10000
)

exec "${CLI}" start "${DEFAULT_FLAGS[@]}" "$@"
