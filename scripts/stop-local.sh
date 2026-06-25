#!/usr/bin/env bash
#
# Gracefully stop the benchmarker daemon (SIGTERM → waits for Buildkite polls).
# Prefer this over pkill during CI eval runs.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CLI="${BENCHMARKER_QUEUE_BIN:-/tmp/benchmarker-queue}"
ln -sf "${ROOT}/dist/cli.js" "${CLI}"

exec "${CLI}" stop
