#!/usr/bin/env bash
set -euo pipefail
cd /Users/patrykkopycinski/Projects/elastic-llm-benchmarker

# Use exact Node version Kibana requires (v24.14.1 per .nvmrc)
export PATH="/Users/patrykkopycinski/.nvm/versions/node/v24.14.1/bin:$PATH"

set -a; source .env; set +a

exec node dist/cli.js start   --config config/local.json   --stage2 --stage3 --ci-evals   --poll-interval 10000
