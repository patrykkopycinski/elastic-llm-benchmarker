#!/usr/bin/env bash
# Orca per-workspace `destroy` for the i9 host. Reads the lifecycle payload on
# stdin, stops the workspace's `orca serve`, and removes its isolated dir.
# Never touches the live ~/Projects/elastic-llm-benchmarker checkout.
set -euo pipefail
SSH_HOST_ALIAS="${I9_SSH_ALIAS:-kibana-i9}"
PAYLOAD="$(cat || true)"
log() { printf '[i9-destroy] %s\n' "$*" >&2; }

WS_NAME="$(printf '%s' "$PAYLOAD" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const j=JSON.parse(s);const r=j.recipeResult||j;process.stdout.write((r.userData&&r.userData.resourceId)||"");}
  catch(e){process.stdout.write("");}
});' 2>/dev/null || true)"

if [ -z "$WS_NAME" ]; then
  log "no workspace name in payload; nothing to clean"
  exit 0
fi
log "cleaning workspace=$WS_NAME"
ssh -o ConnectTimeout=12 -o BatchMode=yes "$SSH_HOST_ALIAS" bash -s "$WS_NAME" <<'REMOTE' >&2
set -euo pipefail
WS="$1"
ROOT="$HOME/Projects/orca-env/$WS"
# Orca is an Electron binary; ps may show the process as "Orca" without the
# original argv. Prefer the exact serve pid captured by the create script, then
# fall back to killing the listener on the recipe port.
PID_FILE="/tmp/$WS-orca-serve.pid"
if [ -s "$PID_FILE" ]; then
  pid=$(cat "$PID_FILE")
  kill "$pid" 2>/dev/null || true
fi
# Fallback for old smoke runs before PID_FILE existed. This recipe owns 9500.
for pid in $(lsof -tiTCP:9500 -sTCP:LISTEN 2>/dev/null || true); do
  kill "$pid" 2>/dev/null || true
done
rm -rf "$ROOT"
rm -f "/tmp/$WS-orca-serve.out" "/tmp/$WS-orca-serve.err" "$PID_FILE"
REMOTE
log "done"
