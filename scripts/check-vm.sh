#!/usr/bin/env bash
#
# check-vm.sh — Quick health check for a VM before running benchmarks.
#
# Verifies all prerequisites are in place without modifying anything.
# Exit code 0 = ready, non-zero = issues found.
#
# Usage:
#   ssh user@vm 'bash -s' < scripts/check-vm.sh

set -uo pipefail

VLLM_IMAGE="${VLLM_IMAGE:-vllm/vllm-openai:v0.15.1}"

PASS=0
FAIL=0

check() {
  local label="$1"
  shift
  if "$@" &>/dev/null; then
    echo -e "  \033[1;32m✓\033[0m $label"
    ((PASS++))
  else
    echo -e "  \033[1;31m✗\033[0m $label"
    ((FAIL++))
  fi
}

echo ""
echo "VM Readiness Check"
echo "──────────────────────────────────────"

check "Docker installed"            command -v docker
check "Docker daemon running"       docker info
check "nvidia-smi available"        command -v nvidia-smi
check "NVIDIA driver loaded"        nvidia-smi
check "nvidia Docker runtime"       sh -c "docker info --format '{{.Runtimes}}' | grep -q nvidia"
check "User in docker group"        sh -c "id -nG | grep -qw docker"
check "vLLM image present ($VLLM_IMAGE)" docker image inspect "$VLLM_IMAGE"
check "GPU visible in container"    docker run --rm --gpus all "$VLLM_IMAGE" nvidia-smi --query-gpu=name --format=csv,noheader

echo ""
echo "──────────────────────────────────────"
echo "  Passed: $PASS   Failed: $FAIL"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "  Run scripts/setup-vm.sh to fix issues."
  exit 1
else
  echo "  VM is ready for benchmarking."
  exit 0
fi
