#!/usr/bin/env bash
#
# setup-ilm.sh — Set up ILM for trace indices.
#
# Usage:
#   ./scripts/setup-ilm.sh
#

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

ES_URL="http://localhost:9200"
ILM_POLICY="benchmarker-traces-policy"
INDEX_TEMPLATE="benchmarker-traces-template"
INDEX_PATTERN=".benchmark-traces-*"
ROLLOVER_ALIAS="benchmarker-traces"
INGEST_PIPELINE="benchmarker-traces-pipeline"

# ─── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo -e "\n\033[1;34m▸ $*\033[0m"; }
ok()   { echo -e "  \033[1;32m✓ $*\033[0m"; }
fail() { echo -e "  \033[1;31m✗ $*\033[0m"; exit 1; }

# ─── Pre-flight check ─────────────────────────────────────────────────────────

if ! curl -sf "${ES_URL}/_cluster/health" &>/dev/null; then
  fail "Elasticsearch is not reachable at ${ES_URL}"
fi
ok "Elasticsearch is reachable at ${ES_URL}"

# ─── ILM Policy ───────────────────────────────────────────────────────────────

log "Creating ILM policy: ${ILM_POLICY}"

curl -sf -X PUT "${ES_URL}/_ilm/policy/${ILM_POLICY}" \
  -H "Content-Type: application/json" \
  -d '{
    "policy": {
      "phases": {
        "hot": {
          "min_age": "0ms",
          "actions": {
            "rollover": {
              "max_size": "50gb",
              "max_age": "1d"
            }
          }
        },
        "delete": {
          "min_age": "30d",
          "actions": {
            "delete": {}
          }
        }
      }
    }
  }' >/dev/null

ok "ILM policy '${ILM_POLICY}' created"

# ─── Index Template ───────────────────────────────────────────────────────────

log "Creating index template: ${INDEX_TEMPLATE}"

curl -sf -X PUT "${ES_URL}/_index_template/${INDEX_TEMPLATE}" \
  -H "Content-Type: application/json" \
  -d "{
    \"index_patterns\": [\"${INDEX_PATTERN}\"],
    \"template\": {
      \"settings\": {
        \"index.lifecycle.name\": \"${ILM_POLICY}\",
        \"index.lifecycle.rollover_alias\": \"${ROLLOVER_ALIAS}\"
      }
    },
    \"priority\": 500,
    \"composed_of\": [],
    \"version\": 1,
    \"_meta\": {
      \"description\": \"Template for benchmarker trace indices\"
    }
  }" >/dev/null

ok "Index template '${INDEX_TEMPLATE}' created (pattern: ${INDEX_PATTERN})"

# ─── Ingest Pipeline ──────────────────────────────────────────────────────────

log "Creating ingest pipeline: ${INGEST_PIPELINE}"

curl -sf -X PUT "${ES_URL}/_ingest/pipeline/${INGEST_PIPELINE}" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Pass-through pipeline for benchmarker traces (placeholder for future enrichment)",
    "processors": []
  }' >/dev/null

ok "Ingest pipeline '${INGEST_PIPELINE}' created"

# ─── Summary ──────────────────────────────────────────────────────────────────

log "ILM setup complete!"
ok "Policy:    ${ILM_POLICY} (rollover at 50GB / 1 day, delete after 30 days)"
ok "Template:  ${INDEX_TEMPLATE} → ${INDEX_PATTERN}"
ok "Pipeline:  ${INGEST_PIPELINE}"
