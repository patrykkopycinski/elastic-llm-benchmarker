#!/usr/bin/env bash
#
# Safe daemon bounce: graceful SIGTERM (which awaits the in-flight deferred
# Buildkite poll — never interrupts a running CI eval), wait for a clean exit,
# then restart on the freshly-built dist/. Used to load the lease-fencing,
# stuck-entry reclaimer, and stale-tunnel fix without killing build #214.
#
set -uo pipefail

ROOT="/Users/patrykkopycinski/Projects/elastic-llm-benchmarker"
cd "$ROOT"
LOG="$ROOT/.smoke-logs/daemon.log"
LOCK="$ROOT/.benchmarker-queue.lock"
CLI="/tmp/benchmarker-queue"
ln -sf "$ROOT/dist/cli.js" "$CLI"

PID="$(tr -dc '0-9' < "$LOCK" 2>/dev/null || true)"
echo "[bounce] $(date '+%H:%M:%S') daemon pid=${PID:-<none>}"

echo "[bounce] $(date '+%H:%M:%S') sending graceful stop (awaits deferred Buildkite poll)"
"$CLI" stop || true

# Wait for the poll to finalize and the daemon to exit cleanly. Bounded by the
# daemon's own pollTimeoutMs (3h) plus slack.
DEADLINE=$(( $(date +%s) + 12600 ))
while true; do
  if [[ ! -f "$LOCK" ]]; then
    echo "[bounce] $(date '+%H:%M:%S') lockfile released — daemon exited cleanly"
    break
  fi
  if [[ -n "$PID" ]] && ! kill -0 "$PID" 2>/dev/null; then
    echo "[bounce] $(date '+%H:%M:%S') pid $PID gone — daemon exited"
    break
  fi
  if [[ $(date +%s) -gt $DEADLINE ]]; then
    echo "[bounce] $(date '+%H:%M:%S') TIMEOUT waiting for graceful shutdown — NOT restarting"
    echo "===BOUNCE_FAILED==="
    exit 1
  fi
  sleep 20
done

sleep 3
echo "[bounce] $(date '+%H:%M:%S') restarting daemon on new dist/"
nohup ./scripts/start-local.sh --daemonize >> "$LOG" 2>&1 &
sleep 20

echo "[bounce] $(date '+%H:%M:%S') recent daemon log after restart:"
tail -10 "$LOG" | sed -E 's/\x1b\[[0-9;]*m//g'
echo "===BOUNCE_COMPLETE==="
