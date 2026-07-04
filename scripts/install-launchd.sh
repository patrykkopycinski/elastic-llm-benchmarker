#!/usr/bin/env bash
#
# Install the elastic-llm-benchmarker daemon as a macOS LaunchAgent so it
# auto-restarts on crash and starts at login/boot (24/7-autonomy P0: daemon
# supervision). Renders deploy/com.elastic-llm-benchmarker.plist.template with
# this checkout's path into ~/Library/LaunchAgents (gitignored location — real
# paths never touch the repo).
#
# Usage:
#   ./scripts/install-launchd.sh          # render + load
#   ./scripts/install-launchd.sh --render  # render only, print next steps
#
# The LaunchAgent runs scripts/start-local.sh, which sources .env, does the
# boot-time log truncate, and execs the daemon.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.elastic-llm-benchmarker"
TEMPLATE="${ROOT}/deploy/${LABEL}.plist.template"
DEST_DIR="${HOME}/Library/LaunchAgents"
DEST="${DEST_DIR}/${LABEL}.plist"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "Error: template not found at $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
sed "s|__REPO_ROOT__|${ROOT}|g" "$TEMPLATE" > "$DEST"
echo "[install-launchd] rendered $DEST"

if [[ "${1:-}" == "--render" ]]; then
  echo "[install-launchd] render-only. To activate:"
  echo "  launchctl unload \"$DEST\" 2>/dev/null || true"
  echo "  launchctl load \"$DEST\""
  exit 0
fi

# Reload if already loaded, then load. bootstrap/bootout are the modern API but
# load/unload is more portable across macOS versions.
launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"
echo "[install-launchd] loaded $LABEL"
echo "[install-launchd] status:"
launchctl list | grep "$LABEL" || echo "  (not yet listed — check $ROOT/.smoke-logs/daemon.log)"
echo
echo "Manage with:"
echo "  launchctl list | grep $LABEL          # is it running?"
echo "  launchctl unload \"$DEST\"              # stop supervision"
echo "  tail -f $ROOT/.smoke-logs/daemon.log  # follow logs"
