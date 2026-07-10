#!/usr/bin/env bash
# deploy-benchmarker.sh — run from ANY machine to update + bounce the i9 benchmarker.
#
# Pushes latest main, then SSHes the i9 to pull/rebuild/bounce via the
# update-benchmarker.sh helper there. The i9's launchd respawns the daemon
# on the fresh binary automatically.
#
# Usage:
#   ~/Projects/elastic-llm-benchmarker/scripts/deploy-benchmarker.sh           # full: push + i9 pull + rebuild + bounce
#   ~/Projects/elastic-llm-benchmarker/scripts/deploy-benchmarker.sh --no-bounce  # push + i9 pull + rebuild only
#   ~/Projects/elastic-llm-benchmarker/scripts/deploy-benchmarker.sh --check    # just show i9 git status, no changes
#
# Requires: kibana-i9 in ~/.ssh/config (already configured).
set -euo pipefail

I9_HOST="kibana-i9"
I9_HELPER="\$HOME/i9-setup/update-benchmarker.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve flags
MODE="full"
for arg in "$@"; do
  case "$arg" in
    --no-bounce) MODE="no-bounce" ;;
    --check)     MODE="check" ;;
  esac
done

echo "=== deploy-benchmarker → i9 ($MODE) ==="

if [ "$MODE" = "check" ]; then
  echo "--- i9 git status ---"
  ssh "$I9_HOST" 'cd ~/Projects/elastic-llm-benchmarker && git fetch origin main 2>&1 && echo "HEAD: $(git log --oneline -1)" && echo "behind origin/main: $(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)" && echo "daemon: $(pgrep -f "benchmarker-queue start" | head -1 || echo none)"'
  exit 0
fi

# 1. Push local main (if there are unpushed commits)
cd "$HERE"
LOCAL_AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
if [ "$LOCAL_AHEAD" -gt 0 ]; then
  echo "--- pushing $LOCAL_AHEAD local commit(s) to origin/main ---"
  git push origin main
else
  echo "--- local main in sync with origin, nothing to push ---"
fi

# 2. SSH the i9 to pull + rebuild + bounce
echo "--- invoking i9 update helper ($MODE) ---"
if [ "$MODE" = "no-bounce" ]; then
  ssh "$I9_HOST" "$I9_HELPER --no-bounce"
else
  ssh "$I9_HOST" "$I9_HELPER"
fi

echo "=== deploy complete ==="
