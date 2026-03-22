#!/usr/bin/env bash
#
# setup-vm.sh — Provision a fresh GCP VM for vLLM model deployment.
#
# Handles all prerequisites discovered during initial bring-up:
#   1. Fix Ubuntu EOL repos (24.10 Oracular and similar)
#   2. Install Docker (if missing)
#   3. Install NVIDIA drivers (if missing)
#   4. Install NVIDIA Container Toolkit (nvidia runtime for Docker)
#   5. Add current user to the docker group
#   6. Pre-pull the pinned vLLM Docker image
#   7. Smoke-test: run nvidia-smi inside a container
#
# Usage (run ON the VM, or pipe via SSH):
#   ssh user@vm 'bash -s' < scripts/setup-vm.sh
#   # or copy and run directly:
#   scp scripts/setup-vm.sh user@vm:~ && ssh user@vm 'chmod +x setup-vm.sh && sudo ./setup-vm.sh'
#
# The script is idempotent — safe to re-run.

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

VLLM_IMAGE="${VLLM_IMAGE:-vllm/vllm-openai:v0.15.1}"

# ─── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo -e "\n\033[1;34m▸ $*\033[0m"; }
ok()   { echo -e "  \033[1;32m✓ $*\033[0m"; }
warn() { echo -e "  \033[1;33m⚠ $*\033[0m"; }
fail() { echo -e "  \033[1;31m✗ $*\033[0m"; exit 1; }

require_root() {
  if [[ $EUID -ne 0 ]]; then
    fail "This script must be run as root (use sudo)."
  fi
}

# ─── Step 0: Root check ──────────────────────────────────────────────────────

require_root

# ─── Step 1: Fix EOL Ubuntu repositories ─────────────────────────────────────
#
# Ubuntu non-LTS releases (e.g. 24.10 Oracular) go EOL quickly and their
# repos get removed from the main mirrors. apt-get update will fail with:
#   "The repository '... Release' no longer has a Release file."
#
# Fix: redirect to old-releases.ubuntu.com which archives all EOL releases.

log "Checking Ubuntu repositories"

source /etc/os-release 2>/dev/null || true
CODENAME="${VERSION_CODENAME:-}"
SUPPORT_STATUS="${SUPPORT_END:-}"

# Known EOL non-LTS codenames whose repos are removed from main mirrors
EOL_CODENAMES="mantic oracular"

needs_repo_fix=false
for eol in $EOL_CODENAMES; do
  if [[ "$CODENAME" == "$eol" ]]; then
    needs_repo_fix=true
    break
  fi
done

if $needs_repo_fix; then
  warn "Ubuntu $VERSION_ID ($CODENAME) is EOL — redirecting repos to old-releases.ubuntu.com"

  # DEB822 format (.sources files, Ubuntu 24.04+)
  for f in /etc/apt/sources.list.d/*.sources; do
    [[ -f "$f" ]] || continue
    if grep -q "archive.ubuntu.com\|security.ubuntu.com" "$f"; then
      sed -i \
        -e 's|http://[a-z0-9.-]*\.gce\.archive\.ubuntu\.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g' \
        -e 's|http://archive\.ubuntu\.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g' \
        -e 's|http://security\.ubuntu\.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g' \
        "$f"
    fi
  done

  # Traditional format (.list files, older Ubuntu)
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do
    [[ -f "$f" ]] || continue
    if grep -q "archive.ubuntu.com\|security.ubuntu.com" "$f"; then
      sed -i \
        -e 's|http://[a-z0-9.-]*\.gce\.archive\.ubuntu\.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g' \
        -e 's|http://archive\.ubuntu\.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g' \
        -e 's|http://security\.ubuntu\.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g' \
        "$f"
    fi
  done

  ok "Repositories redirected to old-releases.ubuntu.com"
else
  ok "Ubuntu $VERSION_ID ($CODENAME) repos are current"
fi

log "Running apt-get update"
apt-get update -qq
ok "Package index updated"

# ─── Step 2: Install Docker ──────────────────────────────────────────────────

log "Checking Docker installation"

if command -v docker &>/dev/null; then
  DOCKER_VER=$(docker --version | head -1)
  ok "Docker already installed: $DOCKER_VER"
else
  warn "Docker not found — installing"
  apt-get install -y ca-certificates curl gnupg

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  # Use the closest supported Ubuntu codename for Docker repo
  DOCKER_CODENAME="$CODENAME"
  # Docker may not have packages for EOL Ubuntu; fall back to nearest LTS
  if $needs_repo_fix; then
    DOCKER_CODENAME="noble"  # 24.04 LTS
  fi

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $DOCKER_CODENAME stable" \
    | tee /etc/apt/sources.list.d/docker.list > /dev/null

  apt-get update -qq
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  ok "Docker installed: $(docker --version | head -1)"
fi

# ─── Step 3: Install NVIDIA drivers ──────────────────────────────────────────

log "Checking NVIDIA GPU and drivers"

if command -v nvidia-smi &>/dev/null; then
  GPU_INFO=$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null || echo "unknown")
  ok "NVIDIA driver present: $GPU_INFO"
else
  warn "nvidia-smi not found — installing NVIDIA drivers"
  apt-get install -y linux-headers-$(uname -r)

  # Add NVIDIA package repo if not present
  if ! dpkg -l | grep -q nvidia-driver; then
    apt-get install -y nvidia-driver-550
  fi

  ok "NVIDIA drivers installed (reboot may be required)"
fi

# ─── Step 4: Install NVIDIA Container Toolkit ────────────────────────────────
#
# Without this, Docker cannot access GPUs. The --runtime nvidia and --gpus flags
# require the nvidia-container-toolkit package and its Docker runtime config.

log "Checking NVIDIA Container Toolkit"

RUNTIMES=$(docker info --format '{{.Runtimes}}' 2>/dev/null || echo "")

if echo "$RUNTIMES" | grep -q "nvidia"; then
  ok "NVIDIA runtime already configured in Docker"
else
  warn "NVIDIA runtime not found — installing nvidia-container-toolkit"

  # Add NVIDIA container toolkit repository
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null

  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y nvidia-container-toolkit

  # Register the nvidia runtime with Docker
  nvidia-ctk runtime configure --runtime=docker

  # Restart Docker to pick up the new runtime
  systemctl restart docker

  ok "NVIDIA Container Toolkit installed and Docker restarted"
fi

# Verify the runtime is now available
RUNTIMES_AFTER=$(docker info --format '{{.Runtimes}}' 2>/dev/null || echo "")
if echo "$RUNTIMES_AFTER" | grep -q "nvidia"; then
  ok "Verified: nvidia runtime registered"
else
  fail "nvidia runtime still not registered after install — check Docker daemon config"
fi

# ─── Step 5: Add user to docker group ────────────────────────────────────────
#
# Without this, non-root users get "permission denied" on the Docker socket.
# The benchmarker's SSH_USE_SUDO=true works around this, but having group
# membership is cleaner and means SSH_USE_SUDO can be set to false.

log "Configuring Docker group membership"

REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo '')}"

if [[ -n "$REAL_USER" && "$REAL_USER" != "root" ]]; then
  if id -nG "$REAL_USER" | grep -qw docker; then
    ok "User '$REAL_USER' is already in the docker group"
  else
    usermod -aG docker "$REAL_USER"
    ok "Added '$REAL_USER' to the docker group (re-login required to take effect)"
  fi
else
  warn "Running as root with no SUDO_USER — skipping docker group setup"
fi

# ─── Step 6: Pre-pull the vLLM Docker image ──────────────────────────────────
#
# Pre-pulling avoids a multi-minute wait on the first benchmark run.
# The pinned version tag ensures reproducible deployments.

log "Pre-pulling vLLM image: $VLLM_IMAGE"

if docker image inspect "$VLLM_IMAGE" &>/dev/null; then
  ok "Image already present: $VLLM_IMAGE"
else
  docker pull "$VLLM_IMAGE"
  ok "Image pulled: $VLLM_IMAGE"
fi

# ─── Step 7: Smoke test — GPU inside Docker ──────────────────────────────────

log "Smoke test: nvidia-smi inside Docker"

SMOKE_OUTPUT=$(docker run --rm --gpus all "$VLLM_IMAGE" nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>&1) || true

if [[ -n "$SMOKE_OUTPUT" && ! "$SMOKE_OUTPUT" =~ "error" ]]; then
  ok "GPU accessible from container:"
  echo "$SMOKE_OUTPUT" | while IFS= read -r line; do
    echo "    $line"
  done
else
  warn "GPU smoke test returned unexpected output:"
  echo "    $SMOKE_OUTPUT"
  warn "The VM may need a reboot for driver changes to take effect."
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  VM setup complete!"
echo ""
echo "  Docker:   $(docker --version 2>/dev/null | head -1)"
echo "  GPU:      $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
echo "  Runtime:  $(docker info --format '{{.Runtimes}}' 2>/dev/null)"
echo "  Image:    $VLLM_IMAGE"
if [[ -n "$REAL_USER" && "$REAL_USER" != "root" ]]; then
echo "  User:     $REAL_USER (docker group: $(id -nG "$REAL_USER" | tr ' ' ', '))"
fi
echo ""
echo "  Next: run the benchmarker from your local machine:"
echo "    npx tsx src/cli.ts benchmark --model <model-id>"
echo "═══════════════════════════════════════════════════════════"
echo ""
