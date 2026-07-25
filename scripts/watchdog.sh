#!/usr/bin/env bash
# elastic-llm-benchmarker watchdog — health check + self-heal
# Daemon runs on kibana-i9. This watchdog runs on M4 and probes i9 remotely.
set -euo pipefail
BENCH_DIR="$HOME/Projects/elastic-llm-benchmarker"
LOG="$BENCH_DIR/.smoke-logs/watchdog.log"
I9="kibana-i9"
I9_API="http://localhost:3456"
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

# 1. i9 launchd jobs (remote check)
for label in com.i9.benchmarker-worker com.elastic-llm-benchmarker-dashboard; do
  PID=$(ssh -o ConnectTimeout=3 "$I9" "launchctl list 2>/dev/null | grep '$label' | awk '{print \$1}'" 2>/dev/null || true)
  if [ -z "$PID" ] || [ "$PID" = "-" ]; then
    add_finding "$label not loaded on i9"
    ssh -o ConnectTimeout=3 "$I9" "launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$label.plist 2>/dev/null" && add_healed "Reloaded $label on i9" || true
  fi
done

# 2. API check (via SSH tunnel or direct if on same network)
API_OK=false
ssh -o ConnectTimeout=3 "$I9" "curl -sf --connect-timeout 3 '$I9_API/api/queue'" >/dev/null 2>&1 && API_OK=true || add_finding "i9 API :3456 not responding"

# 3. Worker process on i9
WORKER_ALIVE=$(ssh -o ConnectTimeout=3 "$I9" "pgrep -f 'benchmarker-queue start' | head -1" 2>/dev/null || true)
[ -z "$WORKER_ALIVE" ] && add_finding "Worker process dead on i9 (launchd should restart)"

# 4. Stale lockfile on i9
LOCKFILE="$BENCH_DIR/.benchmarker-queue.lock"
ssh -o ConnectTimeout=3 "$I9" "if [ -f '$LOCKFILE' ]; then LOCK_PID=\$(cat '$LOCKFILE' 2>/dev/null || echo ''); if [ -n \"\$LOCK_PID\" ] && ! kill -0 \"\$LOCK_PID\" 2>/dev/null; then rm -f '$LOCKFILE'; echo STALE_REMOVED; fi; fi" 2>/dev/null | grep -q STALE_REMOVED && { add_finding "Stale lockfile on i9"; add_healed "Removed stale lockfile on i9"; } || true

# 5. Stale ES lease (only clear if worker is dead)
if [ -n "$ES_URL" ] && [ -n "$ES_KEY" ] && [ -z "$WORKER_ALIVE" ]; then
  LEASE_COUNT=$(curl -sf -H "Authorization: ApiKey $ES_KEY" "$ES_URL/benchmarker-daemon-lease/_count" 2>/dev/null | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('count',0))" 2>/dev/null || echo 0)
  if [ "$LEASE_COUNT" -gt 0 ]; then
    add_finding "ES lease held ($LEASE_COUNT) but worker dead"
    curl -sf -X POST -H "Authorization: ApiKey $ES_KEY" -H 'Content-Type: application/json' \
      "$ES_URL/benchmarker-daemon-lease/_delete_by_query" -d '{"query":{"match_all":{}}}' >/dev/null 2>&1
    add_healed "Cleared stale ES lease"
  fi
fi

# 6. VM reachability (via i9 → GPU VM)
VM_OK=false
ssh -o ConnectTimeout=3 "$I9" "ssh -o ConnectTimeout=3 -i ~/.ssh/id_ed25519_benchmarker patryk@$VM_HOST 'echo OK'" >/dev/null 2>&1 && VM_OK=true || add_finding "GPU VM unreachable from i9"

# 7. VM disk space
if [ "$VM_OK" = true ]; then
  VM_DISK_PCT=$(ssh -o ConnectTimeout=3 "$I9" "ssh -o ConnectTimeout=3 -i ~/.ssh/id_ed25519_benchmarker patryk@$VM_HOST 'df / | tail -1 | awk \"{print \\\$5}\" | tr -d %'" 2>/dev/null || echo 0)
  [ "$VM_DISK_PCT" -gt 90 ] && add_finding "VM disk at ${VM_DISK_PCT}%"
fi

# 8. Queue stats
if [ "$API_OK" = true ]; then
  STATS=$(ssh -o ConnectTimeout=3 "$I9" "curl -sf '$I9_API/api/queue' 2>/dev/null" | python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
done = len([e for e in data if e.get('status') == 'completed'])
active = len([e for e in data if e.get('status') in ('processing', 'benchmarking')])
pending = len([e for e in data if e.get('status') == 'pending'])
print(f'{done} done, {active} active, {pending} pending')
" 2>/dev/null || echo "error")
  log "Queue: $STATS"
fi

# Report
[ -n "$FINDINGS" ] && log "FINDINGS:$FINDINGS"
[ -n "$HEALED" ] && log "HEALED:$HEALED"
[ -z "$FINDINGS" ] && log "OK — worker=${WORKER_ALIVE:-none} api=$API_OK vm=$VM_OK"

