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

# Prefer the Node version pinned by the Kibana checkout's .nvmrc (Stage 2
# evals exec `node scripts/evals.js` *inside* that checkout and Kibana's
# CLI hard-refuses to run on a mismatched major, e.g. "Kibana does not
# support the current Node.js version v25.8.1. Please use Node.js
# v24.14.1."). Falling back to "newest nvm-managed node" (the old behavior)
# is unsafe on any host where a newer nvm install (e.g. v25.x, installed
# for unrelated work) sorts ahead of Kibana's pinned version — that broke
# every Stage 2 eval silently for hours after the 2026-08-07 move off
# kibana-i9 pulled in this host's nvm versions. cli.js itself only needs
# Node >=20 (see package.json engines), so pinning to Kibana's .nvmrc is
# safe for both processes.
KIBANA_NVMRC="${ROOT}/.kibana-cache/.nvmrc"
NODE_BIN=""
if [[ -f "${KIBANA_NVMRC}" ]]; then
  KIBANA_NODE_VERSION="$(tr -d '[:space:]' < "${KIBANA_NVMRC}")"
  NODE_BIN="${HOME}/.nvm/versions/node/v${KIBANA_NODE_VERSION}/bin"
  [[ -d "${NODE_BIN}" ]] || NODE_BIN=""
fi
if [[ -z "${NODE_BIN}" ]]; then
  # No .kibana-cache checkout yet (first run) or pinned version not
  # installed locally — fall back to newest nvm-managed node.
  NODE_BIN="$(ls -d "${HOME}"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
fi
if [[ -n "${NODE_BIN}" ]]; then
  export PATH="${NODE_BIN}:${PATH}"
fi

# Homebrew bin dirs so tools spawned by bare name (cloudflared, ngrok, …)
# resolve under launchd's minimal PATH. The user's Homebrew PATH lives in
# ~/.zshrc, which a `bash -lc` login shell does not source, so without this the
# tunnel service's `spawn cloudflared` fails with ENOENT and Stage 2 Buildkite
# evals can never be triggered.
for brew_bin in /opt/homebrew/bin /usr/local/bin; do
  if [[ -d "${brew_bin}" ]]; then
    export PATH="${brew_bin}:${PATH}"
  fi
done

exec "${ROOT}/scripts/start-local.sh" "$@"
