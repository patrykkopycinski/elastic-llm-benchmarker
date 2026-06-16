# Operational Runbook

Production deployment and operations guide for elastic-llm-benchmarker.

## Table of Contents

- [Deployment](#deployment)
- [Health Monitoring](#health-monitoring)
- [Common Issues](#common-issues)
- [Alerting](#alerting)
- [Maintenance](#maintenance)

---

## Deployment

### Prerequisites

- Node.js 20+
- Elasticsearch 8.x cluster with API key or basic auth
- Kibana instance with Agent Builder enabled (for evals)
- Local Kibana git checkout (for `@kbn/evals`)
- GCP VM with GPU (for vLLM model deployment)
- HuggingFace API token (for model discovery)

### Initial Setup

```bash
# Clone and install
git clone https://github.com/patrykkopycinski/elastic-llm-benchmarker.git
cd elastic-llm-benchmarker
npm install
npm run build

# Verify ES connectivity
ES_URL=https://your-cluster:9243 ES_API_KEY=xxx npx elastic-llm-benchmarker health-check

# Bootstrap Kibana repo (one-time)
KIBANA_REPO_PATH=/path/to/kibana npx elastic-llm-benchmarker bootstrap-kibana
```

### Environment File

Create `.env` or export:

```bash
# Required
ES_URL=https://your-cluster:9243
ES_API_KEY=your-api-key

# For eval runs
KIBANA_URL=http://localhost:5601
KIBANA_REPO_PATH=/path/to/kibana

# For model deployment
GCP_VM_NAME=vllm-gpu-vm
GCP_ZONE=us-central1-a
GCP_PROJECT=your-project

# For discovery
HF_TOKEN=hf_xxx

# Dashboard (optional)
PORT=3100
API_KEYS=key1,key2
REQUIRE_AUTH=true
```

### Starting the Service

```bash
# Full autonomous pipeline
npx elastic-llm-benchmarker start

# Dashboard only
npx elastic-llm-benchmarker queue start

# Single model benchmark (manual)
npx elastic-llm-benchmarker benchmark-model meta-llama/Llama-3.1-8B-Instruct
```

### Process Management

For production, run under a process manager:

```bash
# systemd unit (recommended)
# /etc/systemd/system/llm-benchmarker.service
[Unit]
Description=LLM Benchmarker
After=network.target

[Service]
Type=simple
User=benchmarker
WorkingDirectory=/opt/elastic-llm-benchmarker
EnvironmentFile=/opt/elastic-llm-benchmarker/.env
ExecStart=/usr/bin/node dist/cli.js start
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

```bash
# Dashboard server
# /etc/systemd/system/llm-benchmarker-dashboard.service
[Unit]
Description=LLM Benchmarker Dashboard
After=network.target

[Service]
Type=simple
User=benchmarker
WorkingDirectory=/opt/elastic-llm-benchmarker
EnvironmentFile=/opt/elastic-llm-benchmarker/.env
ExecStart=/usr/bin/node dist/cli.js queue start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

---

## Health Monitoring

### Endpoints

| Endpoint | Purpose | Expected |
|----------|---------|----------|
| `GET /healthz` | Liveness probe | `200` with `{ status: "ok" }` |
| `GET /api/v1/health` | Full health check | `200` when healthy, `503` when degraded |
| `GET /api/v1/health/history` | Check history | Array of snapshots |
| `GET /metrics` | Prometheus scrape | Prometheus text format |
| `GET /metrics/json` | JSON metrics | Operation counters + timings |

### Health Check Components

The `/api/v1/health` endpoint checks:

| Check | What it validates | Failure meaning |
|-------|------------------|-----------------|
| `queue_depth` | Pending entries < 50 | Backlog building up — workers may be stuck |
| `golden_forwarder` | vLLM proxy responding | GPU VM or vLLM container down |
| `discovery_scheduler` | Discovery loop running | Auto-discovery stopped |
| `elasticsearch` | ES cluster reachable | Storage/query unavailable |

### Response Format

```json
{
  "status": "healthy",
  "timestamp": "2026-06-16T08:00:00.000Z",
  "checks": {
    "queue_depth": { "ok": true, "message": "Queue depth is 5" },
    "elasticsearch": { "ok": true, "message": "Cluster green" }
  },
  "uptime": { "seconds": 86400, "memoryMB": 256 },
  "monitoring": {
    "totalChecks": 2880,
    "healthyChecks": 2875,
    "uptimePercent": "99.83",
    "currentStatus": "healthy",
    "failureCounts": { "queue_depth": 0 },
    "historySize": 100
  }
}
```

### Prometheus Integration

Scrape config for `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'llm-benchmarker'
    scrape_interval: 30s
    static_configs:
      - targets: ['localhost:3100']
    metrics_path: /metrics
```

### Kubernetes Probes

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 3100
  initialDelaySeconds: 10
  periodSeconds: 30
readinessProbe:
  httpGet:
    path: /api/v1/health
    port: 3100
  initialDelaySeconds: 15
  periodSeconds: 30
  failureThreshold: 3
```

---

## Common Issues

### 1. Queue Depth Growing

**Symptom:** `/api/v1/health` returns `status: degraded`, `queue_depth` check failing.

**Diagnosis:**
```bash
# Check queue status
npx elastic-llm-benchmarker queue-status

# Check for stuck entries
npx elastic-llm-benchmarker queue-status --status=processing

# Look at worker logs
journalctl -u llm-benchmarker -n 100 --no-pager
```

**Resolution:**
- If entries are stuck in `processing`: the worker crashed mid-run. Cancel and retry:
  ```bash
  curl -X POST http://localhost:3100/api/v1/queue/<id>/retry
  ```
- If entries keep failing: check the model is available on HuggingFace, vLLM can load it
- If queue is genuinely backed up: expected during bulk discovery — monitor, don't intervene

### 2. vLLM / GPU VM Unreachable

**Symptom:** `golden_forwarder` check failing. Stage 1 jobs error with connection timeouts.

**Diagnosis:**
```bash
# Check GCP VM status
gcloud compute instances describe $GCP_VM_NAME --zone=$GCP_ZONE --format='value(status)'

# SSH and check vLLM container
gcloud compute ssh $GCP_VM_NAME --zone=$GCP_ZONE -- docker ps
gcloud compute ssh $GCP_VM_NAME --zone=$GCP_ZONE -- docker logs vllm-server --tail=50
```

**Resolution:**
- VM stopped → `gcloud compute instances start $GCP_VM_NAME --zone=$GCP_ZONE`
- vLLM container crashed → SSH in, `docker restart vllm-server`
- GPU OOM → check model size, may need a smaller quantization

### 3. Elasticsearch Connection Failures

**Symptom:** `/healthz` returns 503. All queue operations fail.

**Diagnosis:**
```bash
# Direct ES check
curl -s "$ES_URL/_cluster/health" -H "Authorization: ApiKey $ES_API_KEY"

# Check index health
curl -s "$ES_URL/_cat/indices/llm-*" -H "Authorization: ApiKey $ES_API_KEY"
```

**Resolution:**
- Cluster red/yellow → check ES cluster health, disk space
- Auth failure → rotate API key, update `.env`
- Network → check firewall rules, VPN, allowlists

### 4. Kibana Eval Failures

**Symptom:** Stage 2 jobs fail with eval errors. Results show 0 scores.

**Diagnosis:**
```bash
# Check Kibana is running
curl -s "$KIBANA_URL/api/status" | jq '.status.overall.level'

# Check eval repo state
cd $KIBANA_REPO_PATH && git status && node scripts/evals --help
```

**Resolution:**
- Kibana down → restart Kibana
- Repo dirty → `cd $KIBANA_REPO_PATH && git stash && git pull`
- Missing connectors → re-run `bootstrap-kibana`

### 5. Discovery Not Finding Models

**Symptom:** Queue stays empty. No new models appearing.

**Diagnosis:**
```bash
# Manual discovery check
npx elastic-llm-benchmarker status

# Check HF token
curl -s -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/api/models?limit=1" | jq '.[] | .id'
```

**Resolution:**
- HF token expired → generate a new one at huggingface.co/settings/tokens
- Rate limited → wait, or check HF rate limit headers
- Filter too aggressive → review discovery config thresholds

---

## Alerting

The health monitor runs checks every 30 seconds and tracks consecutive failures.

### Alert Levels

| Level | Trigger | Action |
|-------|---------|--------|
| `warning` | First failure of any check | Investigate within 1 hour |
| `critical` | 3+ consecutive failures (configurable) | Investigate immediately |

### Custom Alert Handlers

The `HealthMonitor.onAlert()` hook supports custom handlers. To add webhook alerting:

```typescript
import { HealthMonitor } from './services/health-monitor.js';

monitor.onAlert(async (alert) => {
  if (alert.level === 'critical') {
    await fetch('https://hooks.slack.com/services/xxx', {
      method: 'POST',
      body: JSON.stringify({
        text: `🚨 [${alert.level}] ${alert.check}: ${alert.message} (${alert.consecutiveFailures} failures)`,
      }),
    });
  }
});
```

---

## Maintenance

### Index Lifecycle

Benchmark results accumulate over time. Set up ILM:

```bash
# Create ILM policy (retain 90 days)
curl -X PUT "$ES_URL/_ilm/policy/llm-benchmark-cleanup" \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey $ES_API_KEY" \
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

### Updating

```bash
cd /opt/elastic-llm-benchmarker
git pull
npm install
npm run build
sudo systemctl restart llm-benchmarker llm-benchmarker-dashboard
```

### Backup

Results live in Elasticsearch. Use standard ES snapshot/restore:

```bash
# Register snapshot repo (one-time)
curl -X PUT "$ES_URL/_snapshot/llm-backup" \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey $ES_API_KEY" \
  -d '{ "type": "fs", "settings": { "location": "/mnt/backups/llm" } }'

# Take snapshot
curl -X PUT "$ES_URL/_snapshot/llm-backup/snap-$(date +%Y%m%d)" \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey $ES_API_KEY" \
  -d '{ "indices": "llm-*", "include_global_state": false }'
```

### Log Rotation

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
