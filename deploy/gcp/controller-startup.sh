#!/bin/bash
# controller-startup.sh — runs on the controller VM at boot.
#
# Pulls secrets from GCP Secret Manager, then starts the benchmarker
# daemon container. Designed to be used as a systemd service or a
# COS startup-script metadata entry.
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?GCP_PROJECT_ID must be set}"
CONFIG_PATH="${BENCHMARKER_CONFIG:-config/gcp.json}"
API_PORT="${PORT:-3200}"

# ─── Pull secrets from Secret Manager ─────────────────────────────────────────
echo "[startup] Resolving secrets from Secret Manager..."

resolve_secret() {
  local name="$1"
  gcloud secrets versions access latest --secret="$name" --project="$PROJECT_ID"
}

export VLLM_API_KEY="$(resolve_secret vllm-api-key)"
export ES_API_KEY="$(resolve_secret es-api-key)"
export HF_TOKEN="$(resolve_secret hf-token)"
export BUILDKITE_API_TOKEN="$(resolve_secret buildkite-api-token)"

# Internal IP of the GPU VM (stable, provisioned by Terraform)
export GPU_VM_INTERNAL_IP="10.10.0.10"
export SSH_USERNAME="benchmarker"
export SSH_PRIVATE_KEY_PATH="/run/secrets/gpu_vm_ssh_key"

# ─── Start the benchmarker container ─────────────────────────────────────────
echo "[startup] Starting benchmarker daemon on port ${API_PORT}..."

docker run -d \
  --name benchmarker \
  --restart unless-stopped \
  -p "${API_PORT}:3200" \
  -e ELASTICSEARCH_URL="${ES_URL:-}" \
  -e ELASTICSEARCH_API_KEY="${ES_API_KEY}" \
  -e GPU_VM_INTERNAL_IP \
  -e SSH_USERNAME \
  -e SSH_PRIVATE_KEY_PATH \
  -e HUGGINGFACE_TOKEN="${HF_TOKEN}" \
  -e BUILDKITE_API_TOKEN \
  -e GCP_PROJECT_ID="${PROJECT_ID}" \
  -e VLLM_API_KEY \
  -e LOAD_BALANCER_URL="${LOAD_BALANCER_URL:-}" \
  -e LOAD_BALANCER_API_KEY="${VLLM_API_KEY}" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v benchmarker-data:/app/data \
  -v benchmarker-results:/app/results \
  gcr.io/"${PROJECT_ID}"/elastic-llm-benchmarker:latest

echo "[startup] Benchmarker started. Health: http://localhost:${API_PORT}/health"
