#!/usr/bin/env bash
#
# setup-local.sh — Bootstrap the local development stack (Elasticsearch + EDOT collector).
#
# Usage:
#   ./scripts/setup-local.sh
#

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

ES_CONTAINER="benchmarker-es"
ES_IMAGE="docker.elastic.co/elasticsearch/elasticsearch:8.13.0"
ES_PORT=9200

EDOT_CONTAINER="edot-collector"
EDOT_IMAGE="docker.elastic.co/observability/elastic-otel-collector:latest"
EDOT_OTLP_HTTP_PORT=4318
EDOT_HEALTH_PORT=8080

NETWORK_NAME="benchmarker-net"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MAPPINGS_FILE="$PROJECT_ROOT/src/services/es-index-mappings.ts"

# ─── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo -e "\n\033[1;34m▸ $*\033[0m"; }
ok()   { echo -e "  \033[1;32m✓ $*\033[0m"; }
warn() { echo -e "  \033[1;33m⚠ $*\033[0m"; }
fail() { echo -e "  \033[1;31m✗ $*\033[0m"; exit 1; }

# ─── Docker pre-flight ────────────────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  fail "Docker is not installed. Please install Docker first: https://docs.docker.com/get-docker/"
fi
ok "Docker is installed: $(docker --version | head -1)"

# ─── Docker network ───────────────────────────────────────────────────────────

if ! docker network inspect "$NETWORK_NAME" &>/dev/null; then
  log "Creating Docker network: $NETWORK_NAME"
  docker network create "$NETWORK_NAME"
  ok "Network $NETWORK_NAME created"
else
  ok "Network $NETWORK_NAME already exists"
fi

# ─── Elasticsearch ────────────────────────────────────────────────────────────

log "Starting Elasticsearch container: $ES_CONTAINER"

if docker ps -a --format '{{.Names}}' | grep -qx "$ES_CONTAINER"; then
  if docker ps --format '{{.Names}}' | grep -qx "$ES_CONTAINER"; then
    ok "Elasticsearch container '$ES_CONTAINER' is already running"
  else
    warn "Elasticsearch container '$ES_CONTAINER' exists but is stopped. Starting it..."
    docker start "$ES_CONTAINER"
    ok "Elasticsearch container started"
  fi
else
  docker run -d \
    --name "$ES_CONTAINER" \
    --network "$NETWORK_NAME" \
    -p "${ES_PORT}:${ES_PORT}" \
    -e discovery.type=single-node \
    -e xpack.security.enabled=false \
    -e "ES_JAVA_OPTS=-Xms1g -Xmx1g" \
    "$ES_IMAGE"
  ok "Elasticsearch container created and started"
fi

# ─── Wait for ES health ───────────────────────────────────────────────────────

log "Waiting for Elasticsearch to be healthy (yellow/green)..."

for i in {1..60}; do
  STATUS=$(curl -sf "http://localhost:${ES_PORT}/_cluster/health" 2>/dev/null \
    | grep -o '"status":"[^"]*"' \
    | cut -d'"' -f4 || true)

  if [[ "$STATUS" == "green" || "$STATUS" == "yellow" ]]; then
    ok "Elasticsearch is healthy (status: $STATUS)"
    break
  fi

  if [[ $i -eq 60 ]]; then
    fail "Elasticsearch did not become healthy within 120 seconds"
  fi

  sleep 2
done

# ─── Auto-create benchmarker indices ──────────────────────────────────────────

log "Creating benchmarker indices from $MAPPINGS_FILE"

if [[ ! -f "$MAPPINGS_FILE" ]]; then
  fail "Index mappings file not found: $MAPPINGS_FILE"
fi

if command -v npx &>/dev/null && [[ -f "$PROJECT_ROOT/node_modules/.bin/tsx" ]]; then
  "${PROJECT_ROOT}/node_modules/.bin/tsx" - <<'TSX' || warn "Some indices may have failed to create"
    import { INDEX_NAMES, INDEX_MAPPINGS } from "./src/services/es-index-mappings.ts";

    async function createIndex(name: string) {
      const mapping = INDEX_MAPPINGS[name];
      if (!mapping) {
        console.error(`  ✗ No mapping found for index: ${name}`);
        return;
      }
      try {
        const res = await fetch(`http://localhost:9200/${name}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mapping),
        });
        const body = await res.json() as Record<string, unknown>;
        if (res.ok || (body.error as Record<string, string>)?.type === "resource_already_exists_exception") {
          console.log(`  ✓ Index created or already exists: ${name}`);
        } else {
          console.error(`  ✗ Failed to create index ${name}: ${(body.error as Record<string, string>)?.reason ?? JSON.stringify(body)}`);
        }
      } catch (err: any) {
        console.error(`  ✗ Exception creating index ${name}: ${err.message}`);
      }
    }

    (async () => {
      for (const name of Object.values(INDEX_NAMES)) {
        await createIndex(name);
      }
    })();
TSX
else
  warn "tsx not available; skipping automatic index creation. Install dependencies (npm install) to enable this step."
fi

# ─── EDOT Collector ───────────────────────────────────────────────────────────

log "Starting EDOT collector container: $EDOT_CONTAINER"

if docker ps -a --format '{{.Names}}' | grep -qx "$EDOT_CONTAINER"; then
  if docker ps --format '{{.Names}}' | grep -qx "$EDOT_CONTAINER"; then
    ok "EDOT collector container '$EDOT_CONTAINER' is already running"
  else
    warn "EDOT collector container '$EDOT_CONTAINER' exists but is stopped. Starting it..."
    docker start "$EDOT_CONTAINER"
    ok "EDOT collector container started"
  fi
else
  docker run -d \
    --name "$EDOT_CONTAINER" \
    --network "$NETWORK_NAME" \
    -p "${EDOT_OTLP_HTTP_PORT}:${EDOT_OTLP_HTTP_PORT}" \
    -p "${EDOT_HEALTH_PORT}:${EDOT_HEALTH_PORT}" \
    --restart unless-stopped \
    -e ELASTICSEARCH_ENDPOINT="http://${ES_CONTAINER}:9200" \
    "$EDOT_IMAGE"
  ok "EDOT collector container created and started"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

log "Local development stack is ready!"
ok "Elasticsearch URL:  http://localhost:${ES_PORT}"
ok "OTLP HTTP endpoint: http://localhost:${EDOT_OTLP_HTTP_PORT}"
ok "Collector health:   http://localhost:${EDOT_HEALTH_PORT}/healthz"
