#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; source .env; set +a
mkdir -p .smoke-logs

# Kill any existing instances
pkill -f 'node dist/api/queue-server.js' 2>/dev/null || true
pkill -f 'benchmarker-queue start' 2>/dev/null || true
sleep 1

# Start API server
node dist/api/queue-server.js > .smoke-logs/api-server.log 2>&1 &
API_PID=$!
echo $API_PID > .smoke-logs/api-server.pid

# Wait for it to bind
for i in $(seq 1 10); do
  if lsof -iTCP:3456 -sTCP:LISTEN -P -n >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if lsof -iTCP:3456 -sTCP:LISTEN -P -n >/dev/null 2>&1; then
  echo "API_OK PID=$API_PID port=3456"
else
  echo "API_FAIL PID=$API_PID"
  cat .smoke-logs/api-server.log | tail -20
  kill $API_PID 2>/dev/null || true
  exit 1
fi

# Start queue worker
BENCHMARKER_CONFIG="$(pwd)/config/local.json"   /tmp/benchmarker-queue start   --config "$(pwd)/config/local.json"   --stage2 --stage3 --ci-evals   --poll-interval 10000   > .smoke-logs/queue-worker.log 2>&1 &
WORKER_PID=$!
echo $WORKER_PID > .smoke-logs/queue-worker.pid

sleep 3
if kill -0 $WORKER_PID 2>/dev/null; then
  echo "WORKER_OK PID=$WORKER_PID"
else
  echo "WORKER_FAIL PID=$WORKER_PID"
  cat .smoke-logs/queue-worker.log | tail -20
  exit 1
fi

echo "Both daemons started."
echo "API:   http://localhost:3456"
echo "Logs:  .smoke-logs/api-server.log, .smoke-logs/queue-worker.log"
