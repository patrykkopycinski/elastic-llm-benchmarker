#!/usr/bin/env bash
# elastic-llm-benchmarker watchdog — health check + self-heal
set -euo pipefail
BENCH_DIR="$HOME/Projects/elastic-llm-benchmarker"
LOG="$BENCH_DIR/.smoke-logs/watchdog.log"
API="http://localhost:3456"
SSH_KEY="$HOME/.ssh/id_ed25519"
VM_HOST="34.29.5.12"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

mkdir -p "$(dirname "$LOG")"
log() { echo "[$TIMESTAMP] $*" | tee -a "$LOG"; }

# Source .env for ES creds
ES_URL="" ; ES_KEY=""
if [ -f "$BENCH_DIR/.env" ]; then
  set -a; source "$BENCH_DIR/.env"; set +a
  ES_URL="$ELASTICSEARCH_URL"
  ES_KEY="$ELASTICSEARCH_API_KEY"
fi

FINDINGS="" ; HEALED=""
add_finding() { FINDINGS="$FINDINGS
- $1"; }
add_healed() { HEALED="$HEALED
- $1"; }

# 1. launchd jobs
for label in com.elastic-llm-benchmarker.worker com.elastic-llm-benchmarker.dashboard; do
  PID=$(launchctl list 2>/dev/null | grep "$label" | awk '{print $1}')
  if [ -z "$PID" ] || [ "$PID" = "-" ]; then
    add_finding "$label not loaded"
    launchctl load "$HOME/Library/LaunchAgents/$label.plist" 2>/dev/null && add_healed "Reloaded $label" || true
  fi
done

# 2. API check
API_OK=false
curl -sf --connect-timeout 3 "$API/api/queue" >/dev/null 2>&1 && API_OK=true || add_finding "API :3456 not responding"

# 3. Worker process
WORKER_ALIVE=$(pgrep -f 'dist/cli.js start' | head -1 || true)
[ -z "$WORKER_ALIVE" ] && add_finding "Worker process dead (launchd should restart)"

# 4. Stale lockfile
LOCKFILE="$BENCH_DIR/.benchmarker-queue.lock"
if [ -f "$LOCKFILE" ]; then
  LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
    add_finding "Stale lockfile (PID $LOCK_PID dead)"
    rm -f "$LOCKFILE"
    add_healed "Removed stale lockfile"
  fi
fi

# 5. Stale ES lease (only clear if worker is dead)
if [ -n "$ES_URL" ] && [ -n "$ES_KEY" ] && [ -z "$WORKER_ALIVE" ]; then
  LEASE_COUNT=$(curl -sf -H "Authorization: ApiKey $ES_KEY" "$ES_URL/benchmarker-daemon-lease/_count" 2>/dev/null | jq '.count // 0' 2>/dev/null || echo 0)
  if [ "$LEASE_COUNT" -gt 0 ]; then
    add_finding "ES lease held ($LEASE_COUNT) but worker dead"
    curl -sf -X POST -H "Authorization: ApiKey $ES_KEY" -H 'Content-Type: application/json' \
      "$ES_URL/benchmarker-daemon-lease/_delete_by_query" -d '{"query":{"match_all":{}}}' >/dev/null 2>&1
    add_healed "Cleared stale ES lease"
  fi
fi

# 6. VM reachability
VM_OK=false
ssh -i "$SSH_KEY" -o ConnectTimeout=3 -o StrictHostKeyChecking=no "patryk@$VM_HOST" 'echo OK' >/dev/null 2>&1 && VM_OK=true || add_finding "GPU VM unreachable"

# 7. VM disk space
if [ "$VM_OK" = true ]; then
  VM_DISK_PCT=$(ssh -i "$SSH_KEY" -o ConnectTimeout=3 "patryk@$VM_HOST" 'df / | tail -1 | awk "{print \$5}" | tr -d %' 2>/dev/null || echo 0)
  [ "$VM_DISK_PCT" -gt 90 ] && add_finding "VM disk at ${VM_DISK_PCT}%"
fi

# 8. Queue stats
if [ "$API_OK" = true ]; then
  COMPLETED=$(curl -sf "$API/api/queue" 2>/dev/null | jq '[.[]|select(.status=="completed")]|length' 2>/dev/null || echo 0)
  PROCESSING=$(curl -sf "$API/api/queue" 2>/dev/null | jq '[.[]|select(.status=="processing" or .status=="benchmarking")]|length' 2>/dev/null || echo 0)
  PENDING=$(curl -sf "$API/api/queue" 2>/dev/null | jq '[.[]|select(.status=="pending")]|length' 2>/dev/null || echo 0)
  log "Queue: $COMPLETED done, $PROCESSING active, $PENDING pending"
fi

# Report
[ -n "$FINDINGS" ] && log "FINDINGS:$FINDINGS"
[ -n "$HEALED" ] && log "HEALED:$HEALED"
[ -z "$FINDINGS" ] && log "OK — worker=${WORKER_ALIVE:-none} api=$API_OK vm=$VM_OK"
