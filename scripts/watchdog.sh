#!/usr/bin/env bash
# elastic-llm-benchmarker watchdog — health check + self-heal
# Daemon runs locally on this M4 (moved off kibana-i9 on 2026-08-07T15:05).
# Worker + dashboard are local launchd jobs; only the GPU VM is remote.
set -uo pipefail
BENCH_DIR="$HOME/Projects/elastic-llm-benchmarker"
LOG="$BENCH_DIR/.smoke-logs/watchdog.log"
API_URL="http://localhost:3200"
VM_HOST="34.29.5.12"
VM_SSH_KEY="$HOME/.ssh/id_ed25519"
VM_USER="patryk"
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

# 1. Local launchd jobs
for label in com.elastic-llm-benchmarker com.elastic-llm-benchmarker-dashboard; do
  STATE=$(launchctl list "$label" 2>/dev/null | head -1)
  if [ -z "$STATE" ]; then
    add_finding "$label not loaded locally"
    launchctl load "$HOME/Library/LaunchAgents/$label.plist" 2>/dev/null && add_healed "Reloaded $label locally" || true
  fi
done

# 2. Local API check (dashboard/queue-server, port 3200)
API_OK=false
curl -sf --connect-timeout 3 "$API_URL/api/queue" >/dev/null 2>&1 && API_OK=true || add_finding "local API :3200 not responding"

# 3. Worker process locally (with 30s startup grace period)
WORKER_ALIVE=$(pgrep -f 'benchmarker-queue start' | head -1 || true)
if [ -z "$WORKER_ALIVE" ]; then
  LAST_EXIT=$(launchctl list com.elastic-llm-benchmarker 2>/dev/null | head -1 || echo "-")
  if [ "$LAST_EXIT" = "1" ]; then
    log "Worker exit code 1 (likely lease contention during restart) — skipping this tick"
    WORKER_ALIVE="starting"
  else
    add_finding "Worker process dead locally (launchd should restart)"
  fi
fi

# 4. Stale lockfile locally
LOCKFILE="$BENCH_DIR/.benchmarker-queue.lock"
if [ -f "$LOCKFILE" ]; then
  LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null || echo '')
  if [ -n "$LOCK_PID" ] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
    rm -f "$LOCKFILE"
    add_finding "Stale lockfile locally"
    add_healed "Removed stale lockfile locally"
  fi
fi

# 5. Stale ES lease (only clear if worker is dead — never while WORKER_ALIVE is a live pid)
if [ -n "$ES_URL" ] && [ -n "$ES_KEY" ] && [ -z "$WORKER_ALIVE" ]; then
  LEASE_COUNT=$(curl -sf -H "Authorization: ApiKey $ES_KEY" "$ES_URL/benchmarker-daemon-lease/_count" 2>/dev/null | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('count',0))" 2>/dev/null || echo 0)
  if [ "$LEASE_COUNT" -gt 0 ]; then
    add_finding "ES lease held ($LEASE_COUNT) but worker dead"
    curl -sf -X POST -H "Authorization: ApiKey $ES_KEY" -H 'Content-Type: application/json' \
      "$ES_URL/benchmarker-daemon-lease/_delete_by_query" -d '{"query":{"match_all":{}}}' >/dev/null 2>&1
    add_healed "Cleared stale ES lease"
  fi
fi

# 6. GPU VM reachability (direct SSH from this host, no i9 hop)
VM_OK=false
ssh -o ConnectTimeout=5 -o BatchMode=yes -i "$VM_SSH_KEY" "$VM_USER@$VM_HOST" "echo OK" >/dev/null 2>&1 && VM_OK=true || add_finding "GPU VM unreachable directly"

# 7. VM disk space
if [ "$VM_OK" = true ]; then
  VM_DISK_PCT=$(ssh -o ConnectTimeout=5 -i "$VM_SSH_KEY" "$VM_USER@$VM_HOST" "df / | tail -1 | awk '{print \$5}' | tr -d %" 2>/dev/null || echo 0)
  if [ "${VM_DISK_PCT:-0}" -gt 90 ] 2>/dev/null; then
    add_finding "VM disk at ${VM_DISK_PCT}%"
    ssh -o ConnectTimeout=5 -i "$VM_SSH_KEY" "$VM_USER@$VM_HOST" "sudo docker system prune -af --volumes --filter 'label!=keep' 2>&1 | tail -5" >/dev/null 2>&1 || true
    add_healed "Ran docker system prune on VM (disk was ${VM_DISK_PCT}%)"
  fi
fi

# 8. Queue stats + auto-refill if idle
if [ "$API_OK" = true ]; then
  STATS_JSON=$(curl -sf "$API_URL/api/queue" 2>/dev/null || echo '[]')
  STATS=$(echo "$STATS_JSON" | python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
done = len([e for e in data if e.get('status') == 'completed'])
active = len([e for e in data if e.get('status') in ('processing', 'benchmarking', 'deploying')])
pending = len([e for e in data if e.get('status') == 'pending'])
print(f'{done} done, {active} active, {pending} pending')
" 2>/dev/null || echo "error")
  log "Queue: $STATS"
fi

# Report
[ -n "$FINDINGS" ] && log "FINDINGS:$FINDINGS"
[ -n "$HEALED" ] && log "HEALED:$HEALED"
[ -z "$FINDINGS" ] && log "OK — worker=${WORKER_ALIVE:-none} api=$API_OK vm=$VM_OK"
exit 0
