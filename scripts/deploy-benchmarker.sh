#!/usr/bin/env bash
# deploy-benchmarker.sh — run from ANY machine to update + bounce the i9 benchmarker.
#
# Pushes latest main, syncs scripts/update-benchmarker.sh to i9, then SSHes to
# pull/rebuild/bounce. The i9 launchd respawns the daemon on the fresh binary.
#
# Usage:
#   ~/Projects/elastic-llm-benchmarker/scripts/deploy-benchmarker.sh           # full: push + i9 pull + rebuild + bounce
#   ~/Projects/elastic-llm-benchmarker/scripts/deploy-benchmarker.sh --no-bounce  # push + i9 pull + rebuild only
#   ~/Projects/elastic-llm-benchmarker/scripts/deploy-benchmarker.sh --check    # just show i9 git status, no changes
#
# Requires: kibana-i9 in ~/.ssh/config (already configured).
set -euo pipefail

I9_HOST="kibana-i9"
I9_HELPER='$HOME/i9-setup/update-benchmarker.sh'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPDATE_SCRIPT="$HERE/scripts/update-benchmarker.sh"

run_i9_update() {
  local extra_args="${1:-}"
  ssh "$I9_HOST" "mkdir -p ~/i9-setup"
  scp -q "$UPDATE_SCRIPT" "$I9_HOST:~/i9-setup/update-benchmarker.sh"
  ssh "$I9_HOST" "chmod +x ~/i9-setup/update-benchmarker.sh"
  # zsh -lic: login shell loads nvm; update-benchmarker.sh also sources nvm as fallback.
  if [ -n "$extra_args" ]; then
    ssh "$I9_HOST" "zsh -lic '$I9_HELPER $extra_args'"
  else
    ssh "$I9_HOST" "zsh -lic '$I9_HELPER'"
  fi
}

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

# 2. Sync helper + SSH the i9 to pull + rebuild + bounce
echo "--- syncing update-benchmarker.sh + invoking i9 helper ($MODE) ---"
if [ "$MODE" = "no-bounce" ]; then
  run_i9_update "--no-bounce"
else
  run_i9_update ""
fi

echo "=== deploy complete ==="
