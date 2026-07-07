# Operational Runbook

Production deployment and operations guide for elastic-llm-benchmarker.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Initial Setup](#initial-setup)
- [Local-First Eval Iteration](#local-first-eval-iteration)
- [Starting the Service](#starting-the-service)
- [Stopping the Service](#stopping-the-service)
- [Health Monitoring](#health-monitoring)
- [Common Operations](#common-operations)
- [Troubleshooting](#troubleshooting)
- [Maintenance](#maintenance)
- [Disaster Recovery](#disaster-recovery)

---

## Prerequisites

- **Node.js 20+** with npm
- **Elasticsearch 8.x** cluster (Elastic Serverless recommended) with API key
- **GPU VM** with 2x A100-80GB (or equivalent), accessible via SSH
  - Docker installed with NVIDIA Container Toolkit
  - Sufficient disk for model weights (~200GB+ recommended)
- **SSH key** with access to the GPU VM (`chmod 600`)
- **HuggingFace token** (for model discovery, higher API rate limits)
- **Buildkite API token** (optional, for CI eval pipeline)
- **Anthropic API key** (optional, for Stage 3 reasoning)

---

## Initial Setup

### 1. Clone and install

```bash
git clone https://github.com/patrykkopycinski/elastic-llm-benchmarker.git
cd elastic-llm-benchmarker
npm install
npm run build
```

### 2. Configure

Copy and edit the config file:

```bash
cp config/default.json config/local.json
```

Required fields in `config/local.json`:

```jsonc
{
  "ssh": {
    "host": "YOUR_GPU_VM_IP",
    "port": 22,
    "username": "YOUR_SSH_USER",
    "privateKeyPath": "/path/to/ssh/key"
  },
  "elasticsearch": {
    "url": "https://your-cluster.es.cloud.elastic.co",
    "apiKey": "YOUR_ES_API_KEY"
  },
  "huggingfaceToken": "hf_YOUR_TOKEN",
  "hardwareProfileId": "2xa100-80gb",
  "vmHardwareProfile": {
    "gpuType": "nvidia-a100-80gb",
    "gpuCount": 2,
    "ramGb": 340,
    "cpuCores": 24,
    "diskGb": 1000,
    "machineType": "a2-ultragpu-2g"
  }
}
```

### 3. Verify GPU VM connectivity

```bash
# Test SSH connection
ssh -i /path/to/key YOUR_USER@YOUR_GPU_VM_IP 'nvidia-smi && docker --version'

# Verify Docker + NVIDIA runtime
ssh -i /path/to/key YOUR_USER@YOUR_GPU_VM_IP 'docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi'
```

### 4. Verify Elasticsearch connectivity

```bash
npx tsx src/cli.ts health-check --config config/local.json --format json
```

Expected output: all checks pass with `"ok": true`.

### 5. (Optional, opt-in only) Set up Buildkite CI evals

Buildkite is **not** part of the default iteration loop — see [Local-First Eval Iteration](#local-first-eval-iteration) below. Only set this up if you're preparing a sanctioned promotion run:

```jsonc
{
  "buildkite": {
    "enabled": true,
    "apiToken": "bkua_YOUR_TOKEN",
    "orgSlug": "elastic",
    "onDemandPipelineSlug": "kibana-evals-on-demand",
    "weeklyPipelineSlug": "kibana-evals-weekly-llm-evals",
    "retryOnFailure": true,
    "triggerFullEval": false,
    "kibanaBranch": "main"
  }
}
```

`kibanaBranch` must be `"main"` — `buildkite-eval-trigger.ts` throws before POSTing a build otherwise. Prefer using `config/promote-weekly.json` as-is rather than hand-rolling this block.

---

## Local-First Eval Iteration

**Default posture: everything runs locally. Buildkite is opt-in, promotion-only.**

Day-to-day EDD and benchmarker iteration — including verifying fixes to the weekly eval suites — should run against a local or self-hosted Kibana instance pointed at local **EIS, LiteLLM, or vLLM** endpoints. This is `config/local.json`'s default (`evalTier: "local"`, `enableStage2: true`, `buildkite.enabled: false`):

```bash
# Local Stage-2 iteration (no Buildkite involved)
npx tsx src/cli.ts start --config config/local.json --stage2
```

If you're iterating on the matrix/weekly suites specifically from the `agent-builder-skill-dev-cursor-plugin` side, use its local runner instead of triggering Buildkite:

```bash
./scripts/run-local-matrix-suite.sh run-critical
```

**Why:** `kibana-evals-on-demand-llm-evals` and `kibana-evals-weekly-llm-evals` are costly shared CI resources. Triggering them per-iteration (especially from feature/WIP branches) wastes CI capacity and slows feedback loops versus a local run. The weekly Buildkite pipeline is no longer auto-triggered for development purposes — only for the sanctioned promotion step below.

**Temporary branch pin:** `config/local.json` currently points `kibanaRepo.branch` / `buildkite.kibanaBranch` at `fix/weekly-evals-matrix` ([elastic/kibana#274606](https://github.com/elastic/kibana/pull/274606)) so local runs pick up in-flight matrix fixes. Revert both to `main` once that PR merges. `config/default.json` is unaffected and already defaults to `main`.

**Promoting to Buildkite:** once local verification passes, run the explicit opt-in promotion config — never the default:

```bash
npx tsx src/cli.ts start --config config/promote-weekly.json --ci-evals
```

`buildkite-eval-trigger.ts` enforces `kibanaBranch === "main"` for any actual Buildkite POST, independent of whichever branch `config/local.json` uses for local Stage-2 checkouts — so a misconfigured local branch can never accidentally leak into a real CI trigger.

---

## Starting the Service

### Full autonomous pipeline

```bash
npx tsx src/cli.ts start \
  --config config/local.json \
  --stage2 \
  --stage3 \
  --discovery \
  --ci-evals \
  --poll-interval 30000
```

This starts:
- **Queue poller**: checks ES queue every 30s for pending entries
- **Stage 1 worker**: deploys models on GPU VM, runs benchmarks
- **Stage 2 worker**: runs Kibana eval suites (if `--stage2`)
- **Stage 3 worker**: LLM reasoning over results (if `--stage3`)
- **Discovery scheduler**: polls HuggingFace for new models (if `--discovery`)
- **CI eval pipeline**: smoke test + Buildkite triggers (if `--ci-evals`)

### Dashboard only (no processing)

The dashboard is served as part of the API server. Start with:

```bash
npx tsx src/cli.ts start --config config/local.json
```

Dashboard is available at `http://localhost:3200`.

### One-off model benchmark

```bash
# Enqueue with hardware-fit check
npx tsx src/cli.ts enqueue Qwen/Qwen2.5-7B-Instruct --config config/local.json

# Enqueue and wait for completion
npx tsx src/cli.ts benchmark-model Qwen/Qwen2.5-7B-Instruct --wait --config config/local.json
```

### Process management (production)

For production deployments, run under systemd:

```ini
# /etc/systemd/system/llm-benchmarker.service
[Unit]
Description=Elastic LLM Benchmarker
After=network.target

[Service]
Type=simple
User=benchmarker
WorkingDirectory=/opt/elastic-llm-benchmarker
ExecStart=/usr/bin/node dist/cli.js start \
  --config config/production.json \
  --stage2 --stage3 --discovery --ci-evals
Restart=on-failure
RestartSec=30
Environment=NODE_OPTIONS=--max-old-space-size=4096

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable llm-benchmarker
sudo systemctl start llm-benchmarker
```

---

## Stopping the Service

### Graceful shutdown

```bash
# Via CLI (sends SIGTERM to the daemon)
npx tsx src/cli.ts stop

# Via systemd
sudo systemctl stop llm-benchmarker
```

The scheduler handles SIGINT/SIGTERM gracefully:
1. Stops polling for new entries
2. Waits for the current model to finish (does not interrupt mid-benchmark)
3. Tears down any active vLLM deployment on the GPU VM
4. Releases the lockfile
5. Closes ES connections

### Force stop (if graceful fails)

```bash
# Find the process
ps aux | grep benchmarker

# Kill it
kill -9 <PID>

# Clean up the lockfile
rm .benchmarker-queue.lock
```

After a force stop, check for orphaned Docker containers on the GPU VM:

```bash
ssh YOUR_USER@YOUR_GPU_VM_IP 'docker ps --filter "name=vllm-" --format "{{.Names}}"'
ssh YOUR_USER@YOUR_GPU_VM_IP 'docker stop $(docker ps -q --filter "name=vllm-")'
```

---

## Health Monitoring

### Health check endpoints

| Endpoint | Purpose | Expected |
|----------|---------|----------|
| `GET /healthz` | Liveness probe | `200` when ES is reachable |
| `GET /api/v1/health` | Full health check | `200` with component statuses |
| `GET /metrics` | Prometheus scrape | Text format metrics |

### CLI health check

```bash
npx tsx src/cli.ts health-check --config config/local.json --format json
```

Checks: Elasticsearch connectivity, SSH key existence, GPU VM reachability, Docker availability.

### Prometheus scrape config

```yaml
scrape_configs:
  - job_name: 'llm-benchmarker'
    scrape_interval: 30s
    static_configs:
      - targets: ['localhost:3200']
    metrics_path: /metrics
```

### Key signals to monitor

| Signal | Where to check | Healthy | Investigate |
|--------|---------------|---------|-------------|
| Queue depth | `GET /api/stats` or dashboard | 0-5 pending | 10+ growing |
| Current model runtime | Dashboard "Currently Processing" | < 2h per model | > 3h |
| ES cluster health | `GET /healthz` | `green` | `yellow` or `red` |
| GPU VM Docker containers | SSH + `docker ps` | 0-1 vllm containers | 2+ (orphaned) |
| Disk on GPU VM | SSH + `df -h` | > 100 GB free | < 50 GB |
| Error index | ES query `benchmarker-errors` | < 5/day | > 20/day |

---

## Common Operations

### Enqueue a model for benchmarking

```bash
# Standard enqueue (checks hardware fit)
npx tsx src/cli.ts enqueue meta-llama/Llama-3.1-70B-Instruct

# High priority
npx tsx src/cli.ts enqueue meta-llama/Llama-3.1-70B-Instruct --priority 1

# Force enqueue (skip hardware check)
npx tsx src/cli.ts enqueue meta-llama/Llama-3.1-70B-Instruct --force
```

### Check queue status

```bash
npx tsx src/cli.ts queue-status
npx tsx src/cli.ts status --json
```

### View results

```bash
# Latest results
npx tsx src/cli.ts results --limit 10

# Per-model summary
npx tsx src/cli.ts results --summary

# Filter by model
npx tsx src/cli.ts results --model Qwen/Qwen2.5-7B-Instruct
```

### View recommendations

```bash
# Latest recommendation for a model
npx tsx src/cli.ts recommend --model Qwen/Qwen2.5-7B-Instruct

# All "support" verdicts
npx tsx src/cli.ts recommend --verdict support

# JSON output
npx tsx src/cli.ts recommend --format json
```

### Export results

```bash
# JSON export
npx tsx src/cli.ts export --output results.json

# CSV export
npx tsx src/cli.ts export --format csv --output results.csv

# Filtered export
npx tsx src/cli.ts export --status passed --after 2026-06-01
```

### Get vLLM deploy command for a model

```bash
npx tsx src/cli.ts print-deploy-command --model Qwen/Qwen2.5-72B-Instruct --tensor-parallel 2
```

### Run Stage 3 reasoning on a past run

```bash
npx tsx src/cli.ts reasoning <run-id> --config config/local.json
```

---

## Troubleshooting

### 1. Scheduler not processing entries

**Symptom**: Queue has pending entries but nothing is being processed.

**Diagnosis**:
```bash
# Check if daemon is running
cat .benchmarker-queue.lock

# Check logs
journalctl -u llm-benchmarker -n 100 --no-pager

# Check for stuck entries
npx tsx src/cli.ts queue-status
```

**Resolution**:
- Lockfile exists but process is dead: remove `.benchmarker-queue.lock` and restart
- Entry stuck in `deploying`/`benchmarking`: cancel via API, check GPU VM for orphaned containers
- SSH connection failing: verify `ssh -i <key> <user>@<host>` works manually

### 2. vLLM deployment fails

**Symptom**: Stage 1 fails with SSH or Docker errors.

**Diagnosis**:
```bash
# Check GPU VM
ssh YOUR_USER@YOUR_GPU_VM_IP

# Check GPU availability
nvidia-smi

# Check Docker
docker ps -a --filter "name=vllm-"
docker logs <container-name> --tail 50

# Check disk space (model weights can be large)
df -h /root/.cache/huggingface
```

**Resolution**:
- GPU OOM: model too large for available VRAM. Use a smaller model or quantization.
- Docker pull fails: check network, Docker Hub rate limits, or disk space.
- Model download hangs: check HuggingFace token validity, network to HF CDN.
- Container exits immediately: check `docker logs` for vLLM startup errors.

### 3. Elasticsearch connection issues

**Symptom**: Health check shows ES unreachable. Results not being stored.

**Diagnosis**:
```bash
# Direct ES check
curl -s "$ELASTICSEARCH_URL/_cluster/health" \
  -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY"

# Check indices exist
curl -s "$ELASTICSEARCH_URL/_cat/indices/benchmarker-*?v" \
  -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY"
```

**Resolution**:
- API key expired: rotate key, update config
- Cluster red: check ES cluster health, disk space, shard allocation
- Index missing: the service auto-creates indices on startup via `ensureIndices()`
- Network: check firewall rules, VPN, cloud provider security groups

### 4. Discovery not finding models

**Symptom**: Queue stays empty even with `--discovery` enabled.

**Diagnosis**:
```bash
# Test HuggingFace API directly
curl -s -H "Authorization: Bearer $HUGGINGFACE_TOKEN" \
  "https://huggingface.co/api/models?limit=5&filter=text-generation" | jq '.[].id'

# Check discovery scheduler logs
journalctl -u llm-benchmarker --grep "discovery" -n 50
```

**Resolution**:
- HF token expired: generate new token at huggingface.co/settings/tokens
- Rate limited: wait, or use authenticated requests (higher limits)
- Filters too strict: check `discoveryScheduler` config (min downloads, licenses, etc.)
- All discovered models already evaluated: discovery skips previously benchmarked models

### 5. CI eval pipeline fails

**Symptom**: Smoke test passes but Buildkite build fails or times out.

**Diagnosis**:
```bash
# Check Buildkite build status
curl -s -H "Authorization: Bearer $BUILDKITE_API_TOKEN" \
  "https://api.buildkite.com/v2/organizations/elastic/pipelines/kibana-evals-on-demand/builds?per_page=5" \
  | jq '.[].state'

# Check the CI eval results in ES
curl -s "$ELASTICSEARCH_URL/benchmarker-ci-evals/_search?size=5&sort=@timestamp:desc" \
  -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY" | jq '.hits.hits[]._source.status'
```

**Resolution**:
- Build timed out: increase `buildkite.pollTimeoutMs` (default 1h)
- Build failed: check Buildkite build logs for eval suite errors
- Smoke test fails: model may not support tool calling; check model card
- Connector JSON wrong: verify `.gen-ai` connector format matches Kibana's expectations

### 6. Orphaned containers on GPU VM

**Symptom**: GPU memory in use but no benchmark running.

**Resolution**:
```bash
ssh YOUR_USER@YOUR_GPU_VM_IP

# List vLLM containers
docker ps --filter "name=vllm-"

# Stop all vLLM containers
docker stop $(docker ps -q --filter "name=vllm-")

# Remove stopped containers
docker container prune -f

# Verify GPU is free
nvidia-smi
```

### 7. Model fails with "context length too large"

**Symptom**: vLLM refuses to start or OOMs during benchmark.

**Resolution**:
- The system auto-detects max context length from model config. If it's too large for available VRAM, reduce `engine.maxModelLen` in config or let the hardware estimator cap it.
- For very large context windows (128k+), ensure `engine.vllmGpuMemoryUtilization` is set to 0.95 (default).

---

## Maintenance

### Updating the benchmarker

```bash
cd /opt/elastic-llm-benchmarker
git pull
npm install
npm run build
sudo systemctl restart llm-benchmarker
```

### Index lifecycle management

Benchmark data accumulates over time. Set up an ILM policy:

```bash
curl -X PUT "$ELASTICSEARCH_URL/_ilm/policy/benchmarker-cleanup" \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY" \
  -d '{
    "policy": {
      "phases": {
        "delete": {
          "min_age": "90d",
          "actions": { "delete": {} }
        }
      }
    }
  }'
```

Apply to benchmarker indices:

```bash
for idx in benchmarker-results benchmarker-checkpoints benchmarker-errors benchmarker-ci-evals; do
  curl -X PUT "$ELASTICSEARCH_URL/$idx/_settings" \
    -H "Content-Type: application/json" \
    -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY" \
    -d '{ "index.lifecycle.name": "benchmarker-cleanup" }'
done
```

### Cleaning GPU VM disk

Model weights cache grows over time:

```bash
ssh YOUR_USER@YOUR_GPU_VM_IP

# Check cache size
du -sh ~/.cache/huggingface/hub/

# Remove old models (keep only recently used)
# List models sorted by access time
ls -lt ~/.cache/huggingface/hub/models--*/

# Remove specific model cache
rm -rf ~/.cache/huggingface/hub/models--ORG--MODEL/
```

### Rotating credentials

| Credential | Rotation procedure |
|------------|-------------------|
| ES API key | Create new key in Kibana, update config, restart service |
| SSH key | Generate new key, add to GPU VM `authorized_keys`, update `privateKeyPath` |
| HuggingFace token | Generate at huggingface.co/settings/tokens, update config |
| Buildkite token | Generate in Buildkite settings, update config |

After rotating any credential, restart the service:

```bash
sudo systemctl restart llm-benchmarker
```

### Log rotation

When running under systemd, journald handles log rotation. For file-based logging:

```bash
# /etc/logrotate.d/llm-benchmarker
/var/log/llm-benchmarker/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
}
```

---

## Disaster Recovery

### Data loss in Elasticsearch

All data lives in Elasticsearch. Use ES snapshot/restore:

```bash
# Register snapshot repository (one-time)
curl -X PUT "$ELASTICSEARCH_URL/_snapshot/benchmarker-backup" \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY" \
  -d '{ "type": "fs", "settings": { "location": "/mnt/backups/benchmarker" } }'

# Take a snapshot
curl -X PUT "$ELASTICSEARCH_URL/_snapshot/benchmarker-backup/snap-$(date +%Y%m%d)" \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY" \
  -d '{ "indices": "benchmarker-*,benchmark-*,recommendation-*", "include_global_state": false }'

# Restore from snapshot
curl -X POST "$ELASTICSEARCH_URL/_snapshot/benchmarker-backup/snap-20260623/_restore" \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY" \
  -d '{ "indices": "benchmarker-*,benchmark-*,recommendation-*" }'
```

### GPU VM replacement

If the GPU VM needs replacement:

1. Provision new VM with NVIDIA Container Toolkit + Docker
2. Update `ssh.host` in config
3. Copy SSH key to new VM: `ssh-copy-id -i /path/to/key USER@NEW_IP`
4. Restart the benchmarker service
5. The model weights cache will rebuild on first run (downloads from HuggingFace)

### Queue recovery

If entries are stuck:

```bash
# Find stuck entries (in-progress for too long)
curl -s "$ELASTICSEARCH_URL/benchmarker-queue/_search" \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY" \
  -d '{
    "query": {
      "bool": {
        "must": [
          { "term": { "status": "deploying" } },
          { "range": { "started_at": { "lt": "now-2h" } } }
        ]
      }
    }
  }' | jq '.hits.hits[]._id'

# Reset stuck entries to pending
curl -X POST "$ELASTICSEARCH_URL/benchmarker-queue/_update_by_query" \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY" \
  -d '{
    "query": { "term": { "status": "deploying" } },
    "script": { "source": "ctx._source.status = \"pending\"; ctx._source.started_at = null" }
  }'
```
