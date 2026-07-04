#!/usr/bin/env bash
#
# Install an elastic-llm-benchmarker macOS LaunchAgent so it auto-restarts on
# crash and starts at login/boot (24/7-autonomy P0: supervision). Renders the
# matching deploy/*.plist.template with this checkout's path into
# ~/Library/LaunchAgents (gitignored location — real paths never touch the repo).
#
# Two supervised components (the daemon does NOT serve the dashboard):
#   daemon     — the benchmarking daemon (default)
#   dashboard  — the REST API / dashboard (queue-server) on port 3200
#
# Usage:
#   ./scripts/install-launchd.sh                     # daemon: render + load
#   ./scripts/install-launchd.sh --render            # daemon: render only
#   ./scripts/install-launchd.sh dashboard           # dashboard: render + load
#   ./scripts/install-launchd.sh dashboard --render  # dashboard: render only
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# First positional arg selects the component (default daemon). Anything else
# (e.g. --render) is left in place for the render-only check below.
COMPONENT="daemon"
case "${1:-}" in
  daemon | dashboard)
    COMPONENT="$1"
    shift
    ;;
esac

if [[ "$COMPONENT" == "dashboard" ]]; then
  LABEL="com.elastic-llm-benchmarker-dashboard"
  LOG="${ROOT}/.smoke-logs/dashboard.log"
else
  LABEL="com.elastic-llm-benchmarker"
  LOG="${ROOT}/.smoke-logs/daemon.log"
fi
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
launchctl list | grep "$LABEL" || echo "  (not yet listed — check $LOG)"
echo
echo "Manage with:"
echo "  launchctl list | grep $LABEL   # is it running?"
echo "  launchctl unload \"$DEST\"       # stop supervision"
echo "  tail -f $LOG                   # follow logs"
