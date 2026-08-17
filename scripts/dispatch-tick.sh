#!/bin/bash
# Benchmarker fleet dispatch tick.
#
# This is the piece the visibility-platform fleet does NOT have: buzz-acp is
# event-driven, so an agent sleeps until someone speaks to it. A liveness
# heartbeat reports that agents are up; it does not make them work. This posts
# REAL queue state as a prompt into #bench-queue, which is what actually causes
# Fury to pick up the next item unattended.
#
# Silence is the design: if there is nothing to dispatch and nothing degraded,
# it posts nothing. A tick that always fires trains you to ignore it.
set -uo pipefail

BENCH="$HOME/agents-bench"
BUZZ="$HOME/Projects/buzz/target/release/buzz"
export BUZZ_RELAY_URL="wss://macbook-pro-patryk.tail9bbcc.ts.net:13443"

# Benchmarker daemon now runs on kibana-i9, not on this M4 host. The API is
# reached via SSH remote execution; ES is read from the canonical checkout.
I9="kibana-i9"
I9_API="http://localhost:3456"

# Benchmarker canonical repo is the i9 checkout. The M4 path
# ($HOME/Projects/elastic-llm-benchmarker) is a stale shell that only contains
# .env and scripts; the real checkout lives under automaker/.
BENCH_REPO="${BENCHMARKER_REPO:-$HOME/Projects/automaker/elastic-llm-benchmarker}"

# Heartbeat: silence is the design, but silence also looks identical to "the
# tick is dead". Stamp every completed run so staleness is detectable without
# reading launchctl internals. Written on exit regardless of which branch ran.
HEARTBEAT="$BENCH/logs/tick-heartbeat"
trap 'date -u +%Y-%m-%dT%H:%M:%SZ > "$HEARTBEAT"' EXIT

CHAN_QUEUE=$(python3 -c "import json;print(json.load(open('$BENCH/_secrets/channels.json'))['bench-queue'])")
CHAN_OPS=$(python3 -c "import json;print(json.load(open('$BENCH/_secrets/channels.json'))['bench-ops'])")
TICK_SK=$(python3 -c "import json;print(json.load(open('$BENCH/_secrets/keys.json'))['tick']['sk'])")

# Send as the neutral `DispatchTick` identity, never as an agent. `@name` does
# not resolve to a p-tag on a self-mention, so a tick sent as Fury saying
# "@Fury ..." carries no p-tag and wakes nobody. A third identity dispatches
# anyone; it is also on every agent's allowlist and executes no work itself.
send() { # send <channel> <text>
  "$BUZZ" --private-key "$TICK_SK" messages send --channel "$1" \
    --content "$2" >/dev/null 2>&1
}

# --- daemon liveness (probe via i9, not localhost) ---
daemon_pid=$(ssh -o ConnectTimeout=3 "$I9" "launchctl list 2>/dev/null | awk '\$3==\"com.elastic-llm-benchmarker\"{print \$1}'" 2>/dev/null || echo none)
if ! ssh -o ConnectTimeout=3 "$I9" "curl -sf -m 8 -o /dev/null '$I9_API/api/queue'" >/dev/null 2>&1; then
  send "$CHAN_OPS" \
    "@Coulson dispatch tick: ${I9_API}/api/queue is not answering from i9 (launchd pid='${daemon_pid:-none}'). Probe the daemon, report what is actually down, and do not touch the GPU VM."
  exit 0
fi

# --- real queue state, read straight from ES to dodge the size:100 API cap ---
read -r PENDING RUNNING FAILED_RECENT <<<"$(cd "$BENCH_REPO" && set -a && . ./.env && set +a && node -e '
const {Client}=require("@elastic/elasticsearch");
(async()=>{
 try{
  const c=new Client({node:process.env.ELASTICSEARCH_URL,auth:{apiKey:process.env.ELASTICSEARCH_API_KEY}});
  const agg=await c.search({index:"benchmarker-queue",size:0,track_total_hits:true,
    aggs:{s:{terms:{field:"status",size:20}}}});
  const b=Object.fromEntries(agg.aggregations.s.buckets.map(x=>[x.key,x.doc_count]));
  // Schema (queue-service.ts:38) has NO "running" status. In-flight is
  // deploying|benchmarking. Reading b.running always yielded 0, so the tick
  // reported an idle queue during a live GPU benchmark.
  const inflight=(b.deploying||0)+(b.benchmarking||0);
  console.log((b.pending||0),inflight,(b.failed||0));
 }catch(e){ console.log("ERR ERR ERR"); }
})();' 2>/dev/null)"

[ "$PENDING" = "ERR" ] && exit 0
[ -z "${PENDING:-}" ] && exit 0

# Nothing queued, nothing running -> the fleet is genuinely idle. Say so once,
# with the number that matters, and ask for the one decision only a human makes.
if [ "$PENDING" -eq 0 ] && [ "$RUNNING" -eq 0 ]; then
  send "$CHAN_QUEUE" \
    "@Fury dispatch tick: queue is empty (0 pending, 0 running, ${FAILED_RECENT} failed all-time). Daemon is up. Check whether discovery should refill the queue, and if it should not, say what you need from Patryk. Do not restate this if you already reported it and nothing changed."
  exit 0
fi

send "$CHAN_QUEUE" \
  "@Fury dispatch tick: ${PENDING} pending, ${RUNNING} running, ${FAILED_RECENT} failed. Read /api/queue, pick up the next item, and dispatch it. Report only what changed since your last tick."
