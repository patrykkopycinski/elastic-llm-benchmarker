#!/usr/bin/env bash
# Orca per-workspace `create` for the i9 host (Orca-server connection mode).
#
# Runs LOCALLY from the repo root (desktop). SSHes to i9, checks out the
# requested ref into an ISOLATED per-workspace directory (never the live main
# checkout the daemon uses), starts `orca serve`, and prints the pairing JSON.
#
# i9 is a persistent host: Hermes + node are pre-installed (see ~/.local/bin,
# ~/.nvm). Prereqs verified by `orca vm recipe doctor i9-hermes --json`.
set -euo pipefail

# ---- config (env → default) -------------------------------------------------
SSH_HOST_ALIAS="${I9_SSH_ALIAS:-kibana-i9}"        # ~/.ssh/config alias
REMOTE_USER_HOME="/Users/patrykkopycinski"
REMOTE_REPO_URL_SSH="git@github.com:patrykkopycinski/elastic-llm-benchmarker.git"
REPO_REF="${ORCA_REPO_REF:-main}"
ORCA_PORT="${ORCA_PORT:-9500}"                     # free; dashboard owns 3456
# Pairing address the DESKTOP can reach i9 on. Tailscale IPv4.
PAIRING_ADDRESS="${ORCA_PAIRING_ADDRESS:-ws://100.80.240.118:${ORCA_PORT}}"
ORCA_BIN="${I9_ORCA_BIN:-/usr/local/bin/orca}"

# Per-workspace instance name (sanitized, length-capped).
RAW_NAME="orca-${ORCA_VM_RECIPE_ID:-i9-hermes}-${ORCA_VM_INSTANCE_ID:-$$}"
WS_NAME="$(printf '%s' "$RAW_NAME" | tr -c 'a-zA-Z0-9.-' '-' | cut -c1-48)"
REMOTE_WS_ROOT="${REMOTE_USER_HOME}/Projects/orca-env/${WS_NAME}"

log() { printf '[i9-create] %s\n' "$*" >&2; }

# ---- 1. make the host ready: isolated checkout of the ref -------------------
log "workspace=$WS_NAME ref=$REPO_REF root=$REMOTE_WS_ROOT"
ssh -o ConnectTimeout=12 -o BatchMode=yes "$SSH_HOST_ALIAS" bash -s \
  "$REMOTE_REPO_URL_SSH" "$REPO_REF" "$REMOTE_WS_ROOT" "$REMOTE_USER_HOME" <<'REMOTE' >&2
set -euo pipefail
REPO_URL="$1"; REF="$2"; ROOT="$3"; USER_HOME="$4"
export PATH="/usr/local/bin:$USER_HOME/.nvm/versions/node/v24.18.0/bin:$USER_HOME/.local/bin:$PATH"
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=12 -o IdentitiesOnly=yes -i $USER_HOME/.ssh/id_ed25519_benchmarker"
if [ ! -d "$ROOT/.git" ]; then
  git clone --filter=blob:none "$REPO_URL" "$ROOT"
fi
cd "$ROOT"
git fetch origin "$REF"
git checkout -B "$REF" "origin/$REF"
REMOTE

# ---- 2. start orca serve on i9 (background), poll for the recipe JSON -------
log "starting orca serve on i9 :$ORCA_PORT"
REMOTE_OUT="/tmp/${WS_NAME}-orca-serve.out"
REMOTE_ERR="/tmp/${WS_NAME}-orca-serve.err"
REMOTE_PID="/tmp/${WS_NAME}-orca-serve.pid"
ssh -o ConnectTimeout=12 -o BatchMode=yes "$SSH_HOST_ALIAS" bash -s \
  "$REMOTE_WS_ROOT" "$ORCA_PORT" "$PAIRING_ADDRESS" "$ORCA_BIN" \
  "$REMOTE_OUT" "$REMOTE_ERR" "$REMOTE_PID" <<'REMOTE' >&2
set -euo pipefail
ROOT="$1"; PORT="$2"; PAIR="$3"; ORCA_BIN="$4"; OUT="$5"; ERR="$6"; PID_FILE="$7"
: > "$OUT"; : > "$ERR"
nohup "$ORCA_BIN" serve \
  --port "$PORT" \
  --project-root "$ROOT" \
  --pairing-address "$PAIR" \
  --recipe-json >"$OUT" 2>"$ERR" &
echo "$!" > "$PID_FILE"
echo "serve_pid=$!"
REMOTE

# ---- 3. read the recipe JSON serve wrote ------------------------------------
log "polling for recipe JSON"
SERVE_JSON=""
for i in $(seq 1 30); do
  SERVE_JSON="$(ssh -o ConnectTimeout=12 -o BatchMode=yes "$SSH_HOST_ALIAS" \
    "cat '$REMOTE_OUT' 2>/dev/null" 2>/dev/null || true)"
  if printf '%s' "$SERVE_JSON" | grep -q '"pairingCode"'; then break; fi
  sleep 1
done
if ! printf '%s' "$SERVE_JSON" | grep -q '"pairingCode"'; then
  log "ERROR: orca serve did not emit recipe JSON; stderr:"
  ssh -o ConnectTimeout=12 -o BatchMode=yes "$SSH_HOST_ALIAS" "cat '$REMOTE_ERR' 2>/dev/null" >&2 || true
  exit 1
fi

# ---- 4. print serve's JSON (pass pairingCode through unchanged) + userData --
printf '%s' "$SERVE_JSON" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  j.userData={provider:"ssh-host-i9", resourceId:process.argv[1], projectRoot:j.projectRoot};
  process.stdout.write(JSON.stringify(j));
});' "$WS_NAME"
echo
log "done"
