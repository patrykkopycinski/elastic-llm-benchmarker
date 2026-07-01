#!/usr/bin/env bash
#
# smoke-stage3-e2e.sh — End-to-end smoke test for Stage 3 reasoning via EIS.
#
# Exercises: ES + indices → EIS (native on serverless, CCM on self-managed) →
#            Stage3Worker → ES persistence.
#
# Target is auto-detected:
#   • Serverless/cloud  — ELASTICSEARCH_API_KEY set. EIS endpoints are native,
#     so no EIS_CCM_API_KEY and no local ES bootstrap are required.
#   • Self-managed/local — no API key. Boots local ES via setup-local.sh and
#     requires EIS_CCM_API_KEY to activate Cloud Connected Mode.
#
# Usage:
#   npm run smoke:stage3
#   ./scripts/smoke-stage3-e2e.sh
#   ./scripts/smoke-stage3-e2e.sh --skip-setup    # ES already running (local)
#   ./scripts/smoke-stage3-e2e.sh --skip-build    # dist/cli.js already fresh
#
# Requires: .env with ELASTICSEARCH_URL (+ ELASTICSEARCH_API_KEY on serverless,
#           or EIS_CCM_API_KEY on self-managed), jq, npm, docker (local only)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKIP_SETUP=false
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --skip-setup) SKIP_SETUP=true ;;
    --skip-build) SKIP_BUILD=true ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[1;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}▸ $*${NC}"; }
ok()   { echo -e "${GREEN}  ✓ $*${NC}"; }
fail() { echo -e "${RED}  ✗ $*${NC}" >&2; exit 1; }

if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.env"
  set +a
fi

ES_URL="${ELASTICSEARCH_URL:-http://localhost:9223}"

# Auth + target detection. An ES API key ⇒ serverless/cloud (EIS is native).
SERVERLESS=false
ES_AUTH=()
if [[ -n "${ELASTICSEARCH_API_KEY:-}" ]]; then
  SERVERLESS=true
  ES_AUTH=(-H "Authorization: ApiKey ${ELASTICSEARCH_API_KEY}")
elif [[ -n "${ELASTIC_PASSWORD:-}" ]]; then
  ES_AUTH=(-u "elastic:${ELASTIC_PASSWORD}")
fi

# Self-managed requires a CCM key to activate EIS; serverless does not.
if [[ "$SERVERLESS" != "true" ]]; then
  EIS_KEY="${EIS_CCM_API_KEY:-${KIBANA_EIS_CCM_API_KEY:-}}"
  if [[ -z "$EIS_KEY" ]]; then
    fail "Self-managed ES: set EIS_CCM_API_KEY or KIBANA_EIS_CCM_API_KEY in .env"
  fi
fi

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║        Stage 3 EIS — End-to-End Smoke Test                   ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
log "Target: $([[ "$SERVERLESS" == "true" ]] && echo 'serverless (native EIS)' || echo 'self-managed (CCM)')  —  $ES_URL"

# ─── 1. Infrastructure ───────────────────────────────────────────────────────

if [[ "$SERVERLESS" == "true" ]]; then
  log "Checking serverless Elasticsearch reachability"
  ROOT=$(curl -sf "${ES_AUTH[@]}" "$ES_URL/") || fail "Elasticsearch unreachable at $ES_URL (check ELASTICSEARCH_API_KEY)"
  FLAVOR=$(echo "$ROOT" | jq -r '.version.build_flavor // empty')
  [[ "$FLAVOR" == "serverless" ]] || log "  note: build_flavor='$FLAVOR' (expected 'serverless') — proceeding"
  ok "Elasticsearch reachable (build_flavor=$FLAVOR)"
else
  if [[ "$SKIP_SETUP" == "true" ]]; then
    log "Skipping setup-local (--skip-setup)"
  else
    log "Bootstrapping local ES + indices"
    SKIP_EDOT=true "$SCRIPT_DIR/setup-local.sh"
    ok "setup-local.sh complete"
  fi

  log "Checking Elasticsearch"
  ES_STATUS=$(curl -sf "${ES_AUTH[@]}" "$ES_URL/_cluster/health" | jq -r '.status')
  if [[ "$ES_STATUS" != "green" && "$ES_STATUS" != "yellow" ]]; then
    fail "Elasticsearch unhealthy: $ES_STATUS"
  fi
  ES_VERSION=$(curl -sf "${ES_AUTH[@]}" "$ES_URL/" | jq -r '.version.number')
  INFERENCE_URL=$(curl -sf "${ES_AUTH[@]}" "$ES_URL/_cluster/settings?include_defaults=true&flat_settings=true" \
    | jq -r '.defaults["xpack.inference.elastic.url"] // empty')
  if [[ -z "$INFERENCE_URL" ]]; then
    fail "xpack.inference.elastic.url not set — rerun setup-local.sh"
  fi
  ok "Elasticsearch $ES_VERSION ($ES_STATUS), inference URL configured"
fi

# ─── 2. EIS layer ────────────────────────────────────────────────────────────

if [[ "$SERVERLESS" == "true" ]]; then
  log "Validating EIS chat_completion endpoints (native)"
  HAS_CHAT=$(curl -sf "${ES_AUTH[@]}" "$ES_URL/_inference/_all" \
    | jq -r '[.endpoints[]? | select(.task_type=="chat_completion" and .service=="elastic")] | length')
  [[ "${HAS_CHAT:-0}" -ge 1 ]] || fail "No native EIS chat_completion endpoints found on serverless cluster"
  ok "Native EIS chat_completion endpoints available ($HAS_CHAT)"
else
  log "Validating EIS (CCM + streaming client)"
  "$SCRIPT_DIR/validate-eis.sh"
  ok "EIS validation passed"
fi

# ─── 3. Build CLI if needed ──────────────────────────────────────────────────

CLI_DIST="$PROJECT_ROOT/dist/cli.js"
if [[ "$SKIP_BUILD" != "true" && ( ! -f "$CLI_DIST" || "$CLI_DIST" -ot "$PROJECT_ROOT/src/cli.ts" ) ]]; then
  log "Building CLI (dist/cli.js stale or missing)"
  (cd "$PROJECT_ROOT" && npm run build >/dev/null)
fi
[[ -f "$CLI_DIST" ]] || fail "dist/cli.js not found — run npm run build"

QUEUE_BIN="$PROJECT_ROOT/.cache/benchmarker-queue"
mkdir -p "$PROJECT_ROOT/.cache"
ln -sf "$CLI_DIST" "$QUEUE_BIN"

# Prefer the operator's serverless config when present; env vars override anyway.
CONFIG_PATH="config/default.json"
[[ -f "$PROJECT_ROOT/config/local.json" ]] && CONFIG_PATH="config/local.json"

# ─── 4. Stage 3 reasoning ──────────────────────────────────────────────────

RUN_ID="smoke-e2e-$(date +%s)"
log "Running Stage 3 reasoning (runId=$RUN_ID, config=$CONFIG_PATH)"

REASONING_LOG="$(mktemp)"
set +e
(cd "$PROJECT_ROOT" && node "$QUEUE_BIN" reasoning "$RUN_ID" --config "$CONFIG_PATH") \
  >"$REASONING_LOG" 2>&1
REASONING_EC=$?
set -e

cat "$REASONING_LOG"

if [[ $REASONING_EC -ne 0 ]]; then
  fail "Stage 3 reasoning exited with code $REASONING_EC"
fi

if ! grep -q '"category"' "$REASONING_LOG"; then
  fail "Stage 3 output did not contain suggestions JSON"
fi
ok "Stage 3 reasoning completed"

# ─── 5. Verify ES persistence ────────────────────────────────────────────────

DATE_SUFFIX="$(date +%Y-%m-%d)"
REASONING_INDEX="benchmark-reasoning-${DATE_SUFFIX}"

log "Verifying Elasticsearch persistence ($REASONING_INDEX)"
# Exact match via the run_id.keyword subfield (dynamic string mapping creates
# it). Retry to absorb near-real-time refresh latency (serverless refreshes
# asynchronously, so the doc may not be searchable the instant reasoning exits).
FOUND=0
STATUS=""
SUGGESTIONS=0
SEARCH=""
for attempt in 1 2 3 4 5; do
  SEARCH=$(curl -sf "${ES_AUTH[@]}" "$ES_URL/${REASONING_INDEX}/_search" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg id "$RUN_ID" '{query:{term:{"run_id.keyword":$id}}, size:1}')") || SEARCH='{}'
  FOUND=$(echo "$SEARCH" | jq -r '.hits.total.value // 0')
  STATUS=$(echo "$SEARCH" | jq -r '.hits.hits[0]._source.status // empty')
  SUGGESTIONS=$(echo "$SEARCH" | jq -r '.hits.hits[0]._source.suggestions | length // 0')
  if [[ "$FOUND" == "1" && "$STATUS" == "success" && "$SUGGESTIONS" -ge 1 ]]; then
    break
  fi
  sleep 2
done

if [[ "$FOUND" != "1" || "$STATUS" != "success" || "$SUGGESTIONS" -lt 1 ]]; then
  echo "$SEARCH" | jq '.' >&2
  fail "Expected 1 success doc with suggestions, got found=$FOUND status=$STATUS suggestions=$SUGGESTIONS"
fi
ok "Persisted run_id=$RUN_ID ($SUGGESTIONS suggestions)"

rm -f "$REASONING_LOG"

echo ""
echo -e "${GREEN}✓ Stage 3 E2E smoke test passed${NC}"
echo -e "  Run ID:  ${RUN_ID}"
echo -e "  Index:   ${REASONING_INDEX}"
echo -e "  ES URL:  ${ES_URL}"
