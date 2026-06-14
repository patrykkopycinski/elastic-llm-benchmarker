#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NDJSON_FILE="${SCRIPT_DIR}/../dashboard/benchmarker-dashboard.ndjson"

KIBANA_URL=""
API_KEY=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kibana-url)
      KIBANA_URL="$2"
      shift 2
      ;;
    --api-key)
      API_KEY="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 --kibana-url <url> --api-key <key>"
      exit 1
      ;;
  esac
done

if [[ -z "${KIBANA_URL:-}" ]] || [[ -z "${API_KEY:-}" ]]; then
  echo "Usage: $0 --kibana-url <url> --api-key <key>"
  echo ""
  echo "Example:"
  echo "  $0 --kibana-url http://localhost:5601 --api-key AABBCC=="
  exit 1
fi

if [[ ! -f "${NDJSON_FILE}" ]]; then
  echo "ERROR: NDJSON file not found: ${NDJSON_FILE}"
  exit 1
fi

echo "Importing dashboard objects from ${NDJSON_FILE} ..."

# Import via Kibana Saved Objects API
RESPONSE=$(curl -sf -w "\n%{http_code}" \
  "${KIBANA_URL}/api/saved_objects/_import?overwrite=true" \
  -H "kbn-xsrf: true" \
  -H "Authorization: ApiKey ${API_KEY}" \
  --form "file=@${NDJSON_FILE}" 2>/dev/null) || true

HTTP_STATUS=$(echo "${RESPONSE}" | tail -n 1)
BODY=$(echo "${RESPONSE}" | sed '$d')

if [[ "${HTTP_STATUS}" != "200" ]]; then
  echo "ERROR: Import failed with HTTP status ${HTTP_STATUS}"
  echo "Response: ${BODY}"
  exit 1
fi

echo "Import succeeded (HTTP 200)"

# Check for errors in the response body
if command -v jq >/dev/null 2>&1; then
  ERRORS=$(echo "${BODY}" | jq -r '.errors // empty')
  if [[ -n "${ERRORS}" ]] && [[ "${ERRORS}" != "null" ]] && [[ "${ERRORS}" != "[]" ]]; then
    echo "WARN: Some objects had import errors:"
    echo "${BODY}" | jq '.errors'
  else
    SUCCESS_COUNT=$(echo "${BODY}" | jq -r '.successCount // "unknown"')
    echo "Objects imported successfully: ${SUCCESS_COUNT}"
  fi
else
  echo "Response: ${BODY}"
fi

DASHBOARD_URL="${KIBANA_URL}/app/dashboards#/view/dashboard-llm-benchmarker-overview"
echo ""
echo "Dashboard URL: ${DASHBOARD_URL}"
