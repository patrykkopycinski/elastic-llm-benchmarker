#!/usr/bin/env bash
#
# smoke-full-e2e.sh — Full pipeline smoke: HF discovery → Stage 1/2/3 → CI evals → dashboard.
#
# Uses Kibana branch fix/weekly-evals-matrix (elastic/kibana#274606) for Stage 2 + weekly Buildkite.
#
# Usage:
#   source .env && ./scripts/smoke-full-e2e.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
[[ -f .env ]] && set -a && source .env && set +a

PORT="${PORT:-3456}"
ES_URL="${ELASTICSEARCH_URL:-http://localhost:9223}"
KIBANA_BRANCH="${KIBANA_BRANCH:-fix/weekly-evals-matrix}"
LOG_DIR="${ROOT_DIR}/.smoke-logs"
mkdir -p "$LOG_DIR"

export BUILDKITE_API_TOKEN="${BUILDKITE_API_TOKEN:-$(cat "${HOME}/.buildkite/token" 2>/dev/null || true)}"
export BUILDKITE_ENABLED="${BUILDKITE_ENABLED:-true}"
export BUILDKITE_KIBANA_BRANCH="${BUILDKITE_KIBANA_BRANCH:-$KIBANA_BRANCH}"
export BUILDKITE_TRIGGER_FULL_EVAL="${BUILDKITE_TRIGGER_FULL_EVAL:-true}"
export KIBANA_REPO_BRANCH="${KIBANA_REPO_BRANCH:-$KIBANA_BRANCH}"
export ELASTICSEARCH_URL="$ES_URL"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[1;34m'
NC='\033[0m'

log() { echo -e "${BLUE}▸ $*${NC}"; }
ok()  { echo -e "${GREEN}  ✓ $*${NC}"; }
die() { echo -e "${RED}  ✗ $*${NC}" >&2; exit 1; }

echo -e "\n${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Full Pipeline Smoke — HF → Gates → Dashboard             ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo "  Kibana branch: ${KIBANA_BRANCH} (PR #274606)"
echo "  ES:            ${ES_URL}"
echo "  Dashboard:     http://localhost:${PORT}/dashboard"

# ─── Pre-flight ───────────────────────────────────────────────────────────────
log "Pre-flight checks"
curl -sf "${ES_URL}/_cluster/health" >/dev/null || die "Elasticsearch not reachable at ${ES_URL}"
ok "Elasticsearch up"

if [[ -z "${BUILDKITE_API_TOKEN:-}" ]]; then
  die "BUILDKITE_API_TOKEN not set and ~/.buildkite/token missing"
fi
ok "Buildkite token present"

if [[ -z "${HUGGINGFACE_TOKEN:-}" ]]; then
  die "HUGGINGFACE_TOKEN required for model discovery"
fi
ok "HuggingFace token present"

TUNNEL_ON=$(jq -r '.tunnel.enabled // false' config/smoke-full.json 2>/dev/null || echo false)
if [[ "${TUNNEL_ENABLED:-$TUNNEL_ON}" == "true" ]]; then
  if [[ -z "${NGROK_AUTH_TOKEN:-}" ]]; then
    die "NGROK_AUTH_TOKEN required — CI smoke/Buildkite need a public vLLM URL (set in .env)"
  fi
  ok "Ngrok token present (tunnel enabled for CI evals)"
fi

npm run build >/dev/null 2>&1 || die "npm run build failed"
ok "TypeScript build OK"

# ─── Start dashboard API ───────────────────────────────────────────────────────
if curl -sf "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then
  ok "Dashboard API already running on :${PORT}"
else
  log "Starting dashboard API on port ${PORT}"
  nohup npm run api >"${LOG_DIR}/api.log" 2>&1 &
  echo $! >"${LOG_DIR}/api.pid"
  for i in $(seq 1 30); do
    if curl -sf "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then
      ok "Dashboard API started (pid $(cat "${LOG_DIR}/api.pid"))"
      break
    fi
    sleep 1
    [[ $i -eq 30 ]] && die "Dashboard API failed to start — see ${LOG_DIR}/api.log"
  done
fi

# ─── Start pipeline daemon ─────────────────────────────────────────────────────
rm -f "${ROOT_DIR}/.benchmarker-queue.lock"

if pgrep -f 'benchmarker-queue start' >/dev/null 2>&1; then
  ok "Pipeline daemon already running"
else
  log "Starting pipeline daemon (discovery + stage2 + stage3 + ci-evals + full-eval)"
  ln -sf "${ROOT_DIR}/dist/cli.js" /tmp/benchmarker-queue
  nohup node /tmp/benchmarker-queue start \
    --config config/smoke-full.json \
    --stage2 \
    --stage3 \
    --discovery \
    --ci-evals \
    --full-eval \
    >"${LOG_DIR}/daemon.log" 2>&1 &
  echo $! >"${LOG_DIR}/daemon.pid"
  sleep 3
  ok "Pipeline daemon started (pid $(cat "${LOG_DIR}/daemon.pid")) — tail ${LOG_DIR}/daemon.log"
fi

# ─── Wait for discovery to queue a model ───────────────────────────────────────
log "Waiting for HF discovery to queue a model (max 5 min)"
QUEUED_MODEL=""
for i in $(seq 1 60); do
  QUEUE_JSON=$(curl -sf "http://localhost:${PORT}/api/queue" 2>/dev/null || echo '[]')
  QUEUED_MODEL=$(echo "$QUEUE_JSON" | jq -r '.[] | select(.status=="pending" or .status=="claimed") | .modelId' 2>/dev/null | head -1)
  if [[ -n "$QUEUED_MODEL" && "$QUEUED_MODEL" != "null" ]]; then
    ok "Model queued: ${QUEUED_MODEL}"
    break
  fi
  sleep 5
done
[[ -n "$QUEUED_MODEL" && "$QUEUED_MODEL" != "null" ]] || die "No model queued after 5 min — check ${LOG_DIR}/daemon.log"

# ─── Poll until recommendation appears ─────────────────────────────────────────
log "Polling for recommendation report (max 4 h — GPU deploy + evals take time)"
REC_MODEL=""
for i in $(seq 1 480); do
  RECS=$(curl -sf "http://localhost:${PORT}/api/recommendations?limit=5" 2>/dev/null || echo '[]')
  REC_MODEL=$(echo "$RECS" | jq -r '.[0].modelId // empty' 2>/dev/null)
  REC_VERDICT=$(echo "$RECS" | jq -r '.[0].verdict // empty' 2>/dev/null)
  if [[ -n "$REC_MODEL" ]]; then
    ok "Recommendation ready: ${REC_MODEL} → ${REC_VERDICT}"
    echo ""
    echo "$RECS" | jq '.[0] | {modelId, verdict, summary, generatedAt}' 2>/dev/null || echo "$RECS"
    echo ""
    echo -e "${GREEN}Dashboard: http://localhost:${PORT}/dashboard${NC}"
    exit 0
  fi

  # Progress heartbeat every 2 min
  if (( i % 24 == 0 )); then
    STATUS=$(curl -sf "http://localhost:${PORT}/api/queue" 2>/dev/null | jq -r '.[0] | "\(.modelId) \(.status)"' 2>/dev/null || echo "unknown")
    log "Still running… latest queue: ${STATUS} ($(($i * 30))s elapsed)"
    tail -3 "${LOG_DIR}/daemon.log" 2>/dev/null || true
  fi
  sleep 30
done

die "Timeout waiting for recommendation — check ${LOG_DIR}/daemon.log and Buildkite builds"
