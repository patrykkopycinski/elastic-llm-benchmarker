#!/usr/bin/env bash
#
# pull-dra-es-image.sh — Load Elasticsearch from Elastic DRA artifacts.
#
# Resolves the latest build from:
#   https://artifacts-<channel>.elastic.co/elasticsearch/latest/<branch>.json
#
# DRA dashboard: https://artifacts-staging.elastic.co/dra-info/index.html
#   - Snapshot tab → master  (default: ES 9.5.0-SNAPSHOT)
#   - Staging tab  → 9.4, 9.3, 8.19
#
# Usage:
#   ./scripts/pull-dra-es-image.sh
#   eval "$(./scripts/pull-dra-es-image.sh --export)"
#
# Environment:
#   ES_DRA_CHANNEL      snapshot | staging (default: snapshot)
#   ES_DRA_BRANCH       branch name (default: master for snapshot, 9.4 for staging)
#   ES_DRA_CACHE_DIR    cache directory for tarballs
#   ES_IMAGE_TAG        local docker tag (default: benchmarker-elasticsearch:<channel>-<branch>)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CHANNEL="${ES_DRA_CHANNEL:-snapshot}"
BRANCH="${ES_DRA_BRANCH:-}"
CACHE_DIR="${ES_DRA_CACHE_DIR:-$PROJECT_ROOT/.cache/es-dra}"
EXPORT=false

if [[ "${1:-}" == "--export" ]]; then
  EXPORT=true
fi

case "$CHANNEL" in
  snapshot|staging) ;;
  *)
    echo "[dra-es] ERROR: ES_DRA_CHANNEL must be 'snapshot' or 'staging' (got: ${CHANNEL})" >&2
    exit 1
    ;;
esac

if [[ -z "$BRANCH" ]]; then
  if [[ "$CHANNEL" == snapshot ]]; then
    BRANCH=master
  else
    BRANCH=9.4
  fi
fi

DRA_BASE="https://artifacts-${CHANNEL}.elastic.co"
LOCAL_TAG="${ES_IMAGE_TAG:-benchmarker-elasticsearch:${CHANNEL}-${BRANCH}}"

case "$(uname -m)" in
  arm64|aarch64) DOCKER_ARCH=arm64 ;;
  *) DOCKER_ARCH=amd64 ;;
esac

log() { echo "[dra-es] $*" >&2; }

if ! command -v docker >/dev/null 2>&1; then
  log "ERROR: docker is required"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  log "ERROR: jq is required"
  exit 1
fi

log "Resolving latest ${CHANNEL} ES for branch ${BRANCH}..."
LATEST_JSON="$(curl -fsSL "${DRA_BASE}/elasticsearch/latest/${BRANCH}.json")"
VERSION="$(echo "$LATEST_JSON" | jq -r '.version')"
BUILD_ID="$(echo "$LATEST_JSON" | jq -r '.build_id')"
MANIFEST_URL="$(echo "$LATEST_JSON" | jq -r '.manifest_url')"

if [[ -z "$VERSION" || "$VERSION" == "null" || -z "$BUILD_ID" || "$BUILD_ID" == "null" ]]; then
  log "ERROR: Could not resolve ${CHANNEL} build for branch ${BRANCH}"
  log "Check https://artifacts-staging.elastic.co/dra-info/index.html (${CHANNEL} tab)"
  exit 1
fi

log "Latest ${CHANNEL} build: ${BUILD_ID} (ES ${VERSION})"

MANIFEST="$(curl -fsSL "$MANIFEST_URL")"
PACKAGE_KEY="elasticsearch-${VERSION}-docker-image-${DOCKER_ARCH}.tar.gz"
DOCKER_URL="$(echo "$MANIFEST" | jq -r --arg k "$PACKAGE_KEY" '.projects.elasticsearch.packages[$k].url // empty')"

if [[ -z "$DOCKER_URL" ]]; then
  log "ERROR: Package ${PACKAGE_KEY} not found in manifest"
  exit 1
fi

CHANNEL_CACHE="${CACHE_DIR}/${CHANNEL}"
mkdir -p "$CHANNEL_CACHE"
CACHE_FILE="${CHANNEL_CACHE}/${BUILD_ID}-${DOCKER_ARCH}.tar.gz"

if [[ ! -f "$CACHE_FILE" ]]; then
  log "Downloading ${PACKAGE_KEY} (~500MB, cached at ${CACHE_FILE})..."
  curl -fsSL "$DOCKER_URL" -o "$CACHE_FILE"
else
  log "Using cached tarball ${CACHE_FILE}"
fi

log "Loading docker image..."
LOAD_OUTPUT="$(docker load < "$CACHE_FILE")"
echo "$LOAD_OUTPUT" >&2

SOURCE_IMAGE="$(echo "$LOAD_OUTPUT" | awk '/Loaded image:/ {print $NF}' | tail -1)"
if [[ -z "$SOURCE_IMAGE" ]]; then
  log "ERROR: docker load did not report a loaded image"
  exit 1
fi

docker tag "$SOURCE_IMAGE" "$LOCAL_TAG" >/dev/null
log "Tagged ${SOURCE_IMAGE} -> ${LOCAL_TAG}"

if [[ "$EXPORT" == true ]]; then
  printf 'export ES_IMAGE=%q\n' "$LOCAL_TAG"
  printf 'export ES_DRA_VERSION=%q\n' "$VERSION"
  printf 'export ES_DRA_BUILD_ID=%q\n' "$BUILD_ID"
  printf 'export ES_DRA_CHANNEL=%q\n' "$CHANNEL"
  printf 'export ES_DRA_BRANCH=%q\n' "$BRANCH"
else
  echo "$LOCAL_TAG"
fi
