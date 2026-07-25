#!/usr/bin/env bash
set -euo pipefail
cd "/Users/patrykkopycinski/Projects/elastic-llm-benchmarker"
set -a; source .env; set +a
exec /Users/patrykkopycinski/.hermes/node/bin/node dist/api/queue-server.js
