#!/usr/bin/env bash
#
# launchd entrypoint for the benchmarker daemon.
#
# launchd starts processes with a minimal environment and no login shell, so
# this wrapper restores the pieces start-local.sh relies on:
#   - the newest nvm-managed node on PATH (cli.js uses `#!/usr/bin/env node`)
# and then hands off to start-local.sh, which sources .env / .env.docker and
# the Buildkite token before exec'ing the daemon.
#
# Install the LaunchAgent from deploy/com.elastic-llm-benchmarker.plist:
#   cp deploy/com.elastic-llm-benchmarker.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.elastic-llm-benchmarker.plist
# KeepAlive restarts the daemon on crash — the P0 supervision guarantee.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Newest nvm node so the cli.js shebang resolves under launchd's bare PATH.
NODE_BIN="$(ls -d "${HOME}"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [[ -n "${NODE_BIN}" ]]; then
  export PATH="${NODE_BIN}:${PATH}"
fi

exec "${ROOT}/scripts/start-local.sh" "$@"
