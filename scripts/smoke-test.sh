#!/usr/bin/env bash
#
# smoke-test.sh — End-to-end smoke test for the elastic-llm-benchmarker.
#
# Validates all critical infrastructure without disrupting existing services
# on the GPU VM.
#
# Usage:
#   source .env && ./scripts/smoke-test.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ─── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
NC='\033[0m' # No Color

PASS=0
FAIL=0
WARN=0

# ─── Helpers ──────────────────────────────────────────────────────────────────
log()  { echo -e "${BLUE}▸ $*${NC}"; }
ok()   { echo -e "${GREEN}  ✓ $*${NC}"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}  ✗ $*${NC}"; FAIL=$((FAIL + 1)); }
warn() { echo -e "${YELLOW}  ⚠ $*${NC}"; WARN=$((WARN + 1)); }

# ─── Pre-flight checks ────────────────────────────────────────────────────────

if [[ -z "${ELASTICSEARCH_URL:-}" ]]; then
  echo -e "${RED}ELASTICSEARCH_URL is not set. Please source .env first.${NC}"
  exit 1
fi

ES_HOST="$(echo "$ELASTICSEARCH_URL" | sed -E 's|.*://||; s|/.*||')"
ES_AUTH=""
if echo "$ELASTICSEARCH_URL" | grep -q '@'; then
  ES_AUTH="$(echo "$ELASTICSEARCH_URL" | sed -E 's|.*://([^@]+)@.*|\1|')"
fi

curl_es() {
  if [[ -n "$ES_AUTH" ]]; then
    curl -sf -u "$ES_AUTH" "$@"
  else
    curl -sf "$@"
  fi
}

echo -e "\n${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Elastic LLM Benchmarker — E2E Smoke Test               ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"

# ═══════════════════════════════════════════════════════════════════════════════
# 1. Elasticsearch
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${BLUE}━━━ 1. Elasticsearch ━━━${NC}"

log "Checking cluster health"
if ES_STATUS=$(curl_es "http://${ES_HOST}/_cluster/health" 2>/dev/null | jq -r '.status' 2>/dev/null); then
  if [[ "$ES_STATUS" == "green" || "$ES_STATUS" == "yellow" ]]; then
    ok "Cluster status: ${ES_STATUS}"
  else
    warn "Cluster status: ${ES_STATUS} (acceptable but not ideal)"
  fi
else
  fail "Cannot reach Elasticsearch at ${ES_HOST}"
fi

log "Writing test document"
TEST_INDEX="smoke-test-$(date +%s)"
if curl_es -X POST "http://${ES_HOST}/${TEST_INDEX}/_doc" -H "Content-Type: application/json" \
  -d '{"test": true, "timestamp": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' >/dev/null 2>&1; then
  ok "Test document indexed successfully"
  # Cleanup
  curl_es -X DELETE "http://${ES_HOST}/${TEST_INDEX}" >/dev/null 2>&1 || true
else
  fail "Failed to write test document"
fi

log "Checking benchmarker indices"
if curl_es "http://${ES_HOST}/_cat/indices/.benchmark-*?v" 2>/dev/null | grep -q benchmark; then
  ok "Benchmarker indices exist"
else
  warn "No benchmarker indices found yet (expected on fresh install)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 2. Kibana
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${BLUE}━━━ 2. Kibana ━━━${NC}"

log "Checking Kibana status"
if command -v jq >/dev/null 2>&1; then
  KIBANA_STATUS=$(curl -sf "http://localhost:5601/api/status" 2>/dev/null | jq -r '.status.overall.level' 2>/dev/null || echo "unavailable")
else
  KIBANA_STATUS=$(curl -sf "http://localhost:5601/api/status" 2>/dev/null | grep -o '"level":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "unavailable")
fi

if [[ "$KIBANA_STATUS" == "available" ]]; then
  ok "Kibana is available"
else
  warn "Kibana status: ${KIBANA_STATUS}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 3. Queue Server
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${BLUE}━━━ 3. Queue Server ━━━${NC}"

QUEUE_URL="http://localhost:${PORT:-3101}"

log "Checking queue server health"
if QUEUE_HEALTH=$(curl -sf "${QUEUE_URL}/healthz" 2>/dev/null); then
  if echo "$QUEUE_HEALTH" | grep -q '"status":"healthy"'; then
    ok "Queue server healthy"
  else
    warn "Queue server returned: ${QUEUE_HEALTH}"
  fi
else
  fail "Queue server not reachable at ${QUEUE_URL}"
fi

log "Submitting test job (POST /api/v1/evaluate)"
TEST_JOB=$(curl -sf -X POST "${QUEUE_URL}/api/v1/evaluate" \
  -H "Content-Type: application/json" \
  -d '{"modelId": "gpt2", "priority": 100, "skipReasoning": true}' 2>/dev/null || true)

if [[ -n "${TEST_JOB:-}" ]] && echo "$TEST_JOB" | grep -q '"id"'; then
  JOB_ID=$(echo "$TEST_JOB" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  ok "Evaluation queued: ${JOB_ID}"

  # Cleanup — cancel the test evaluation so it doesn't pollute the queue
  curl -sf -X DELETE "${QUEUE_URL}/api/v1/queue/${JOB_ID}" >/dev/null 2>&1 || true
else
  fail "Failed to queue test evaluation (response: ${TEST_JOB:-empty})"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 4. GPU VM — SSH Connectivity
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${BLUE}━━━ 4. GPU VM — SSH Connectivity ━━━${NC}"

if [[ -z "${SSH_HOST:-}" || -z "${SSH_USERNAME:-}" ]]; then
  warn "SSH_HOST or SSH_USERNAME not set, skipping VM tests"
else
  log "Testing SSH connection to ${SSH_USERNAME}@${SSH_HOST}"
  if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
       -o BatchMode=yes -o LogLevel=ERROR \
       "${SSH_USERNAME}@${SSH_HOST}" "echo 'SSH_OK'" >/dev/null 2>&1; then
    ok "SSH connection established"
  else
    fail "SSH connection failed"
  fi

  log "Checking GPU availability"
  GPU_INFO=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
    -o BatchMode=yes -o LogLevel=ERROR \
    "${SSH_USERNAME}@${SSH_HOST}" "nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits" 2>/dev/null || true)

  if [[ -n "$GPU_INFO" ]]; then
    GPU_COUNT=$(echo "$GPU_INFO" | wc -l | tr -d ' ')
    ok "${GPU_COUNT} GPU(s) detected"
    while IFS=',' read -r NAME USED TOTAL UTIL; do
      USED_MB=$(echo "$USED" | tr -d ' ')
      TOTAL_MB=$(echo "$TOTAL" | tr -d ' ')
      UTIL_PCT=$(echo "$UTIL" | tr -d ' ')
      USED_GB=$((USED_MB / 1024))
      TOTAL_GB=$((TOTAL_MB / 1024))
      echo -e "      ${GREEN}• $(echo "$NAME" | xargs): ${USED_GB}GB / ${TOTAL_GB}GB (${UTIL_PCT}%)${NC}"
    done <<< "$GPU_INFO"
  else
    fail "Cannot query GPU status via SSH"
  fi

  log "Checking Docker availability"
  if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
     -o BatchMode=yes -o LogLevel=ERROR \
     "${SSH_USERNAME}@${SSH_HOST}" "sudo docker ps --format '{{.Names}} {{.Status}}'" >/dev/null 2>&1; then
    ok "Docker is available on VM"
  else
    warn "Docker may not be available (or requires sudo)"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 5. vLLM API (existing instance)
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${BLUE}━━━ 5. vLLM API (Existing Instance) ━━━${NC}"

if [[ -z "${SSH_HOST:-}" ]]; then
  warn "SSH_HOST not set, skipping vLLM API test"
else
  log "Querying vLLM /v1/models endpoint"
  MODELS=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
    -o BatchMode=yes -o LogLevel=ERROR \
    "${SSH_USERNAME}@${SSH_HOST}" "curl -s http://localhost:8000/v1/models" 2>/dev/null || true)

  if [[ -n "$MODELS" ]] && echo "$MODELS" | grep -q '"id"'; then
    MODEL_ID=$(echo "$MODELS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    ok "vLLM API responding — model: ${MODEL_ID}"
  else
    warn "vLLM API not responding on port 8000"
  fi

  log "Sending test chat completion"
  CHAT_RESPONSE=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
    -o BatchMode=yes -o LogLevel=ERROR \
    "${SSH_USERNAME}@${SSH_HOST}" \
    "curl -s http://localhost:8000/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{\"model\": \"dummy\", \"messages\": [{\"role\": \"user\", \"content\": \"Say OK\"}], \"max_tokens\": 5, \"temperature\": 0.0}'" 2>/dev/null || true)

  if [[ -n "$CHAT_RESPONSE" ]] && echo "$CHAT_RESPONSE" | grep -q '"choices"'; then
    ok "Chat completion endpoint working"
  else
    warn "Chat completion test inconclusive (may need correct model name)"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 6. Build / Typecheck
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${BLUE}━━━ 6. Build Verification ━━━${NC}"

log "Checking TypeScript build"
if [[ -d "${ROOT_DIR}/dist" ]]; then
  ok "Build output exists (dist/)"
else
  warn "No dist/ found — run 'npm run build' before deploying"
fi

log "Checking CLI binary"
if [[ -x "${ROOT_DIR}/dist/cli.js" ]]; then
  ok "CLI binary is executable"
else
  warn "CLI binary not found or not executable"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                      Smoke Test Summary                      ║${NC}"
echo -e "${BLUE}╠══════════════════════════════════════════════════════════════╣${NC}"
printf  "${BLUE}║${NC}  ${GREEN}✓ Passed:${NC} %-50s ${BLUE}║${NC}\n" "$PASS"
printf  "${BLUE}║${NC}  ${RED}✗ Failed:${NC} %-50s ${BLUE}║${NC}\n" "$FAIL"
printf  "${BLUE}║${NC}  ${YELLOW}⚠ Warnings:${NC} %-48s ${BLUE}║${NC}\n" "$WARN"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"

if [[ $FAIL -gt 0 ]]; then
  echo -e "\n${RED}Smoke test FAILED — ${FAIL} critical issue(s) need attention.${NC}"
  exit 1
else
  echo -e "\n${GREEN}Smoke test PASSED — all critical infrastructure is healthy.${NC}"
  if [[ $WARN -gt 0 ]]; then
    echo -e "${YELLOW}Note: ${WARN} warning(s) detected — review above for details.${NC}"
  fi
  exit 0
fi
