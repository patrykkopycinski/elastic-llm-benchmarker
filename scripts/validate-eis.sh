#!/usr/bin/env bash
#
# validate-eis.sh — Smoke-test EIS CCM + streaming inference against local ES.
#
# Prerequisites: benchmarker-es running with trial license + QA inference URL
# (see scripts/setup-local.sh). Requires EIS_CCM_API_KEY or KIBANA_EIS_CCM_API_KEY.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ES_URL="${ELASTICSEARCH_URL:-http://localhost:9223}"

if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.env"
  set +a
fi

API_KEY="${EIS_CCM_API_KEY:-${KIBANA_EIS_CCM_API_KEY:-}}"
if [[ -z "$API_KEY" ]]; then
  echo "ERROR: Set EIS_CCM_API_KEY or KIBANA_EIS_CCM_API_KEY in .env" >&2
  exit 1
fi

echo "▸ ES version"
curl -sf "$ES_URL/" | jq -r '.version.number'

echo "▸ Activating CCM"
HTTP=$(curl -s -o /tmp/ccm.json -w '%{http_code}' -X PUT "$ES_URL/_inference/_ccm" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg k "$API_KEY" '{api_key: $k}')")
if [[ "$HTTP" != "200" ]]; then
  echo "CCM failed (HTTP $HTTP):" >&2
  cat /tmp/ccm.json >&2
  exit 1
fi
echo "  ✓ CCM active"

echo "▸ Streaming inference"
STREAM=$(curl -sN -X POST \
  "$ES_URL/_inference/chat_completion/.anthropic-claude-4.6-opus-chat_completion/_stream?timeout=3m" \
  -H 'Content-Type: application/json' \
  -H 'X-Elastic-Product-Use-Case: elastic-llm-benchmarker' \
  -d '{"messages":[{"role":"user","content":"Reply with exactly: EIS OK"}]}' | head -20)
echo "$STREAM" | grep -q 'EIS OK' && echo "  ✓ Stream returned EIS OK"

echo "▸ EisLlmClient via tsx"
cd "$PROJECT_ROOT"
node_modules/.bin/tsx - <<'TSX'
import { Client } from '@elastic/elasticsearch';
import { EisLlmClient } from './src/services/eis-llm-client.ts';

const esUrl = process.env.ELASTICSEARCH_URL ?? 'http://localhost:9223';
const apiKey = process.env.EIS_CCM_API_KEY ?? process.env.KIBANA_EIS_CCM_API_KEY;
if (!apiKey) throw new Error('missing API key');

const es = new Client({ node: esUrl });
const client = new EisLlmClient(
  es,
  apiKey,
  process.env.EIS_MODEL ?? 'eis/anthropic-claude-4.6-opus',
  esUrl,
);

const result = await client.complete({
  userPrompt: 'Reply with exactly: CLIENT OK',
});
console.log('  ✓ EisLlmClient:', result.content.trim(), `(${result.finishReason})`);
await es.close();
TSX

echo "✓ EIS validation passed"
