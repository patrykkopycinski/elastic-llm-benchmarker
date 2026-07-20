#!/usr/bin/env bash
# update-benchmarker.sh — pull, rebuild, and bounce the benchmarker daemon (i9 canonical copy).
#
# Sync to i9: ~/i9-setup/update-benchmarker.sh (deploy-benchmarker.sh invokes it).
#
# Usage:
#   ./scripts/update-benchmarker.sh
#   ./scripts/update-benchmarker.sh --no-bounce
set -euo pipefail

# i9 runs nvm in login shells only — source it for non-interactive SSH deploys.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi

REPO="${BENCHMARKER_REPO:-$HOME/Projects/elastic-llm-benchmarker}"
NO_BOUNCE=false
for arg in "$@"; do
  case "$arg" in
    --no-bounce) NO_BOUNCE=true ;;
  esac
done

cd "$REPO"

# i9 RAM pressure: allow Scout boot polls up to ~30m (1800 × 1s) instead of default ~10m.
export BOOT_POLL_ATTEMPTS="${BOOT_POLL_ATTEMPTS:-1800}"

echo "=== update-benchmarker (BOOT_POLL_ATTEMPTS=$BOOT_POLL_ATTEMPTS) ==="

if [ -d .git ]; then
  git fetch origin main
  LOCAL_BEHIND=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
  if [ "$LOCAL_BEHIND" -gt 0 ]; then
    echo "--- pulling $LOCAL_BEHIND commit(s) from origin/main ---"
    if ! git pull --ff-only origin main 2>/dev/null; then
      # Dirty working tree (common on i9: operator config tweaks land as
      # uncommitted edits between deploys). Stash, retry, then drop the stash
      # if its content is already on origin/main (so stashes don't accumulate
      # across deploys and re-block the next pull). Non-merged stash is kept.
      echo "--- working tree dirty — stashing local changes to pull ---"
      STASH_REF=$(git stash create)
      if [ -n "$STASH_REF" ]; then
        git stash push -u -m "update-benchmarker $(date +%s)" >/dev/null
        if git pull --ff-only origin main; then
          # Re-check: does the stashed content still differ from origin/main?
          STASH_TOP=$(git rev-parse stash@{0} 2>/dev/null)
          if [ -n "$STASH_TOP" ] && ! git diff --quiet "origin/main..$STASH_TOP" -- 2>/dev/null; then
            echo "--- stash content differs from origin/main — kept for manual triage ---"
          else
            echo "--- stash content already on origin/main — dropping ---"
            git stash drop stash@{0} >/dev/null
          fi
        fi
      else
        echo "ERROR: pull failed and no stashable changes — aborting deploy"
        exit 1
      fi
    fi
  else
    echo "--- already on latest origin/main ---"
  fi
fi

echo "--- npm ci + build ---"
npm ci
npm run build

# Best-effort Scout pre-warm: prime HF/ES snapshot caches before the next Stage 2 batch.
# Does not fail deploy when plugin checkout or scout CLI is absent.
PLUGIN_DIR="${SKILL_DEV_PLUGIN_DIR:-}"
if [ -z "$PLUGIN_DIR" ] && [ -f config/local.json ]; then
  PLUGIN_DIR=$(node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('config/local.json','utf8'));
    process.stdout.write(cfg.stage2Local?.skillDevPluginDir ?? '');
  " 2>/dev/null || true)
fi

if [ -n "$PLUGIN_DIR" ] && [ -d "$PLUGIN_DIR/scripts" ]; then
  echo "--- scout pre-warm (best-effort, 120s cap) ---"
  (
    cd "$PLUGIN_DIR"
    export BOOT_POLL_ATTEMPTS
    if [ -f scripts/run-security-evals-batch.sh ]; then
      # Dry listing only — avoids booting a full stack during deploy.
      bash scripts/run-security-evals-batch.sh --help >/dev/null 2>&1 || true
    fi
    if [ -f scripts/evals.js ]; then
      timeout 120 node scripts/evals.js boot --dry-run 2>/dev/null || true
    fi
  ) || echo "(scout pre-warm skipped — non-fatal)"
else
  echo "--- scout pre-warm skipped (no skillDevPluginDir) ---"
fi

if [ "$NO_BOUNCE" = true ]; then
  echo "=== update complete (no bounce) ==="
  exit 0
fi

echo "--- graceful daemon bounce ---"
if pgrep -f "benchmarker-queue start" >/dev/null 2>&1; then
  if [ -x ./scripts/stop-local.sh ]; then
    ./scripts/stop-local.sh || true
  else
    pkill -TERM -f "benchmarker-queue start" || true
  fi
  sleep 3
fi

if [ -x ./scripts/start-local.sh ]; then
  ./scripts/start-local.sh --daemonize
else
  echo "WARN: start-local.sh missing — start daemon manually"
fi

echo "=== update complete ==="
