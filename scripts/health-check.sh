#!/usr/bin/env bash
#
# health-check.sh — Check all infrastructure dependencies before a benchmark run.
#
# Usage:
#   ./scripts/health-check.sh [--json]
#
# Options:
#   --json   Output machine-readable JSON instead of human-readable text.
#

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

ES_URL="${ELASTICSEARCH_URL:-http://localhost:9200}"
EDOT_HEALTH_URL="${EDOT_HEALTH_URL:-http://localhost:8080/healthz}"
EDOT_CHECK="${EDOT_CHECK:-optional}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source .env for credentials not already provided by the caller (e.g. CLI pre-flight).
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  # shellcheck source=/dev/null
  set -a
  # Preserve explicitly-set env vars (config file values passed by benchmarker-queue start).
  _saved_ssh_host="${SSH_HOST:-}"
  _saved_ssh_port="${SSH_PORT:-}"
  _saved_ssh_username="${SSH_USERNAME:-}"
  _saved_ssh_key_path="${SSH_KEY_PATH:-}"
  _saved_es_url="${ELASTICSEARCH_URL:-}"
  source "$PROJECT_ROOT/.env"
  [[ -n "$_saved_ssh_host" ]] && SSH_HOST="$_saved_ssh_host"
  [[ -n "$_saved_ssh_port" ]] && SSH_PORT="$_saved_ssh_port"
  [[ -n "$_saved_ssh_username" ]] && SSH_USERNAME="$_saved_ssh_username"
  [[ -n "$_saved_ssh_key_path" ]] && SSH_KEY_PATH="$_saved_ssh_key_path"
  [[ -n "$_saved_es_url" ]] && ELASTICSEARCH_URL="$_saved_es_url"
  set +a
fi

# Only pull the local dev-ES basic-auth password when no API key is configured.
# On serverless (API key set) basic auth would 401 and must not be introduced.
if [[ -z "${ELASTICSEARCH_API_KEY:-}" && -z "${ELASTIC_PASSWORD:-}" && -f "$PROJECT_ROOT/.env.docker" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$PROJECT_ROOT/.env.docker"
  set +a
fi

ES_URL="${ELASTICSEARCH_URL:-http://localhost:9223}"

SSH_HOST="${SSH_HOST:-}"
SSH_PORT="${SSH_PORT:-22}"
SSH_USERNAME="${SSH_USERNAME:-}"
SSH_KEY_PATH="${SSH_KEY_PATH:-}"

JSON_MODE=false
if [[ "${1:-}" == "--json" ]]; then
  JSON_MODE=true
fi

PASS=0
FAIL=0
RESULTS=()

# ─── Helpers ──────────────────────────────────────────────────────────────────

record_pass() {
  local label="$1"
  RESULTS+=("{\"check\":\"${label}\",\"status\":\"PASS\"}")
  ((PASS++)) || true
}

record_fail() {
  local label="$1"
  RESULTS+=("{\"check\":\"${label}\",\"status\":\"FAIL\"}")
  ((FAIL++)) || true
}

# Run a check command. If it succeeds, record a pass; otherwise record a fail.
# Usage: run_check "label" command [args...]
run_check() {
  local label="$1"
  shift
  if "$@" &>/dev/null; then
    if [[ "$JSON_MODE" == "false" ]]; then
      echo -e "  [PASS] ${label}"
    fi
    record_pass "$label"
  else
    if [[ "$JSON_MODE" == "false" ]]; then
      echo -e "  [FAIL] ${label}"
    fi
    record_fail "$label"
  fi
}

# ─── Checks ───────────────────────────────────────────────────────────────────

if [[ "$JSON_MODE" == "false" ]]; then
  echo "Infrastructure Health Check"
  echo "──────────────────────────────────────"
fi

# 1. Elasticsearch
# Prefer API key (serverless / cloud) over basic auth. Basic auth against
# serverless returns 401, so it must never take precedence when a key is set.
ES_CURL_AUTH=()
if [[ -n "${ELASTICSEARCH_API_KEY:-}" ]]; then
  ES_CURL_AUTH=(-H "Authorization: ApiKey ${ELASTICSEARCH_API_KEY}")
elif [[ -n "${ELASTIC_PASSWORD:-}" ]]; then
  ES_CURL_AUTH=(-u "elastic:${ELASTIC_PASSWORD}")
fi

# Serverless ES does not expose /_cluster/health (returns 410); it is a managed
# service, so reachability of the root endpoint is the correct readiness check.
# Stateful clusters keep the green/yellow cluster-health gate.
#
# Bodies are fetched here with direct array expansion (so an "Authorization:
# ApiKey <key>" header with spaces stays a single argument) and the captured
# text is grepped by the check functions — avoids re-splitting inside sh -c.
ES_ROOT_BODY="$(curl -sf ${ES_CURL_AUTH[*]+"${ES_CURL_AUTH[@]}"} "${ES_URL}/" 2>/dev/null || true)"
if echo "$ES_ROOT_BODY" | grep -q '"build_flavor"[[:space:]]*:[[:space:]]*"serverless"'; then
  check_serverless_es() { echo "$ES_ROOT_BODY" | grep -q '"cluster_name"'; }
  run_check "Elasticsearch (serverless) is reachable" check_serverless_es
else
  ES_HEALTH_BODY="$(curl -sf ${ES_CURL_AUTH[*]+"${ES_CURL_AUTH[@]}"} "${ES_URL}/_cluster/health" 2>/dev/null || true)"
  check_stateful_es() { echo "$ES_HEALTH_BODY" | grep -qE '"status":"(green|yellow)"'; }
  run_check "Elasticsearch is reachable and healthy (yellow/green)" check_stateful_es
fi

# 2. EDOT collector (optional by default — set EDOT_CHECK=required to enforce)
if [[ "$EDOT_CHECK" == "required" ]]; then
  run_check "EDOT collector health endpoint is responding" \
    curl -sf "$EDOT_HEALTH_URL"
else
  if curl -sf "$EDOT_HEALTH_URL" >/dev/null 2>&1; then
    record_pass "EDOT collector health endpoint is responding"
    [[ "$JSON_MODE" == "false" ]] && echo "  [PASS] EDOT collector health endpoint is responding"
  else
    [[ "$JSON_MODE" == "false" ]] && echo "  [SKIP] EDOT collector not running (optional)"
  fi
fi

# 3. SSH connectivity to GPU VM
if [[ -n "$SSH_HOST" && -n "$SSH_USERNAME" ]]; then
  SSH_OPTS=(-o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p "$SSH_PORT")
  if [[ -n "$SSH_KEY_PATH" ]]; then
    SSH_OPTS+=(-i "$SSH_KEY_PATH")
  fi
  run_check "SSH connectivity to GPU VM (${SSH_USERNAME}@${SSH_HOST}:${SSH_PORT})" \
    ssh "${SSH_OPTS[@]}" \
        "${SSH_USERNAME}@${SSH_HOST}" \
        true
else
  if [[ "$JSON_MODE" == "false" ]]; then
    echo -e "  [FAIL] SSH connectivity to GPU VM (SSH_HOST or SSH_USERNAME not configured)"
  fi
  record_fail "SSH connectivity to GPU VM (SSH_HOST or SSH_USERNAME not configured)"
fi

# ─── Output ───────────────────────────────────────────────────────────────────

if [[ "$JSON_MODE" == "true" ]]; then
  # Build JSON object manually to avoid dependencies
  printf '{"passed":%d,"failed":%d,"checks":[' "$PASS" "$FAIL"
  local first=true
  local item
  for item in "${RESULTS[@]}"; do
    if [[ "$first" == "true" ]]; then
      first=false
    else
      printf ","
    fi
    printf "%s" "$item"
  done
  printf ']}\n'
else
  echo "──────────────────────────────────────"
  echo "  Passed: $PASS   Failed: $FAIL"
  echo ""
  if [[ $FAIL -gt 0 ]]; then
    echo "  Some checks failed. Fix issues before running benchmarks."
  else
    echo "  All checks passed. Infrastructure is ready."
  fi
fi

# Exit with appropriate code
if [[ $FAIL -gt 0 ]]; then
  exit 1
else
  exit 0
fi
