# elastic-llm-benchmarker

Automated LLM discovery, deployment, and benchmarking for Elastic Agent Builder qualification.

Discovers promising models from HuggingFace, deploys them on vLLM, runs Kibana `@kbn/evals` suites, and stores results in Elasticsearch — fully autonomous, queue-driven.

## Quick Start

```bash
# Install
npm install

# Configure (minimal)
export ES_URL=https://your-es-cluster:9243
export ES_API_KEY=your-api-key
export KIBANA_URL=http://localhost:5601
export KIBANA_REPO_PATH=/path/to/kibana

# Run a single model benchmark
npx elastic-llm-benchmarker benchmark-model meta-llama/Llama-3.1-8B-Instruct

# Or start the full autonomous pipeline
npx elastic-llm-benchmarker start
```

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Discovery   │────▶│    Queue     │────▶│   Worker    │
│  Scheduler   │     │   Service    │     │  Pipeline   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                                │
                          ┌─────────────────────┼─────────────────────┐
                          ▼                     ▼                     ▼
                    ┌───────────┐        ┌───────────┐        ┌───────────┐
                    │  Stage 1  │        │  Stage 2  │        │  Results  │
                    │  vLLM     │        │  Kibana   │        │  ES Store │
                    │  Deploy   │        │  Evals    │        │           │
                    └───────────┘        └───────────┘        └───────────┘
```

**Pipeline stages:**
1. **Discovery** — scans HuggingFace for tool-calling models, filters by size/quantization/recency
2. **Queue** — prioritised work queue in Elasticsearch with deduplication
3. **Stage 1 (vLLM)** — deploys model on GPU VM, validates tool-calling
4. **Stage 2 (Evals)** — runs `@kbn/evals` suites against the deployed model
5. **Results** — stores scores, traces, and reasoning in Elasticsearch

## Commands

### Core Pipeline

| Command | Description |
|---------|-------------|
| `start` | Start the full autonomous pipeline (discovery → queue → benchmark) |
| `stop` | Stop the running pipeline |
| `status` | Show pipeline status, queue depth, and active work |
| `benchmark-model <id>` | Benchmark a single model end-to-end |
| `benchmark` | Run benchmarks from the queue |

### Queue Management

| Command | Description |
|---------|-------------|
| `queue-status [id]` | Show queue entries (optionally filter by ID) |
| `queue <modelId>` | Manually enqueue a model for benchmarking |
| `enqueue <modelId>` | Enqueue a model via the discovery pipeline |

### Results & Reporting

| Command | Description |
|---------|-------------|
| `results` | Show benchmark results from Elasticsearch |
| `report` | Generate a markdown report of results |
| `export` | Export results to JSON/CSV |
| `reasoning <runId>` | Show reasoning traces for a specific run |

### Infrastructure

| Command | Description |
|---------|-------------|
| `health-check` | Run health checks (ES, EDOT, GPU VM) |
| `bootstrap-kibana` | Set up Kibana repo for eval runs |
| `setup-local` | Configure local development environment |
| `deploy-and-test-tool-calls` | Deploy vLLM + validate tool calling |
| `tool-call-benchmark` | Run tool-call-specific benchmarks |
| `migrate-to-es` | Migrate local results to Elasticsearch |

### Dashboard Server

| Command | Description |
|---------|-------------|
| `queue start` | Start the dashboard + API server (default: port 3200) |

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ES_URL` | Yes | Elasticsearch cluster URL |
| `ES_API_KEY` | One of | ES API key (preferred) |
| `ES_USERNAME` / `ES_PASSWORD` | One of | ES basic auth |
| `KIBANA_URL` | For evals | Kibana instance URL |
| `KIBANA_REPO_PATH` | For evals | Path to local Kibana git checkout |
| `GCP_VM_NAME` | For vLLM | GCP VM instance name for GPU workloads |
| `GCP_ZONE` | For vLLM | GCP zone (default: `us-central1-a`) |
| `GCP_PROJECT` | For vLLM | GCP project ID |
| `HF_TOKEN` | For discovery | HuggingFace API token |
| `PORT` | No | Dashboard server port (default: 3200) |
| `API_KEYS` | No | Comma-separated API keys for dashboard auth |
| `REQUIRE_AUTH` | No | Set `true` to require API key auth |

### Elasticsearch Indices

| Index | Purpose |
|-------|---------|
| `llm-benchmark-results` | Benchmark scores and metadata |
| `llm-benchmark-queue` | Work queue entries |
| `llm-tool-call-results` | Tool-calling validation results |
| `llm-eval-traces` | Eval run traces and reasoning |

## API Endpoints

The dashboard server (`queue start`) exposes:

### Queue Management
- `GET /api/v1/queue` — List queue entries (supports `?status=`, `?limit=`, `?sort=`)
- `POST /api/v1/queue` — Enqueue a model `{ modelId, priority?, metadata? }`
- `PATCH /api/v1/queue/:id` — Update entry status
- `DELETE /api/v1/queue/:id` — Remove a queue entry
- `POST /api/v1/queue/:id/cancel` — Cancel a running entry
- `POST /api/v1/queue/:id/retry` — Retry a failed entry
- `GET /api/v1/queue/current` — Currently processing entry

### Results
- `GET /api/v1/results` — Benchmark results (supports `?limit=`, `?modelId=`)

### Health & Monitoring
- `GET /healthz` — Basic liveness probe (ES ping)
- `GET /api/v1/health` — Comprehensive health with check details, uptime, and monitoring summary
- `GET /api/v1/health/history` — Health check history (supports `?limit=`)
- `GET /metrics` — Prometheus-format metrics
- `GET /metrics/json` — JSON-format metrics

### Dashboard
- `GET /` — Web dashboard (queue status, results, real-time updates)
- `GET /api/v1/queue/stream` — SSE stream for real-time queue updates

## Recommendation Reports

After each pipeline run, a **Recommendation Report** is generated with a verdict:

| Verdict | Meaning |
|---------|---------|
| `support` | Model meets all thresholds and eval suites — ready for production |
| `investigate` | Model partially passes — worth manual review |
| `reject` | Model fails critical thresholds — not suitable |

```bash
# Get latest recommendation for a model
npx elastic-llm-benchmarker recommend --model meta-llama/Llama-3.1-8B-Instruct

# List all recommendations by verdict
npx elastic-llm-benchmarker recommend --verdict support --limit 10
```

## External Users (Phase 2 — Local Connector)

Run the benchmarker without Elasticsearch by using the local connector:

```bash
# Start with local file output (no ES required)
npx elastic-llm-benchmarker start \
  --connector local \
  --output-dir ./my-results \
  --config config.yaml

# Results are written as JSON files:
# ./my-results/benchmarks/      — Stage 1 benchmark results
# ./my-results/recommendations/ — Recommendation reports + index.jsonl
# ./my-results/stage2/          — Kibana eval results
# ./my-results/stage3/          — Reasoning analysis
```

The `Connector` interface (`src/services/connector.ts`) can be extended for custom storage backends.

## Development

```bash
# Run tests
npm test

# Type check
npx tsc --noEmit

# Build
npm run build

# Lint
npm run lint
```

### Project Structure

```
src/
├── cli.ts                          # CLI entry point (commander)
├── api/
│   └── queue-server.ts             # Express API + dashboard server
├── services/
│   ├── model-discovery.ts          # HuggingFace model discovery
│   ├── llm-client.ts               # LLM API client (OpenAI-compatible)
│   ├── kibana-repo-service.ts      # Kibana repo management
│   ├── kibana-eval-runner.ts       # @kbn/evals suite runner
│   ├── eval-suite-runner.ts        # End-to-end eval orchestration
│   ├── queue-service.ts            # ES-backed work queue
│   ├── elasticsearch-results-store.ts  # Results persistence
│   ├── health-monitor.ts           # Periodic health monitoring + alerting
│   ├── system-health-check.ts      # Individual health checks
│   ├── monitoring-integration.ts   # Prometheus + JSON metrics
│   ├── metrics-collector.ts        # Operation timing/error tracking
│   ├── trace-query-builder.ts      # OTLP trace queries
│   ├── reasoning-prompt-builder.ts # Reasoning trace formatting
│   ├── recommendation-report-builder.ts # Verdict computation
│   ├── connector.ts                # Pluggable storage interface
│   ├── elasticsearch-connector.ts  # ES storage (default)
│   ├── local-connector.ts          # Local file storage (Phase 2)
│   ├── golden-forwarder.ts         # Async replication to shared cluster
│   └── slack-notifier.ts           # Slack webhook notifications
├── worker/
│   ├── stage1-worker.ts            # vLLM deployment + tool-call validation
│   └── stage2-gate.ts              # Kibana eval execution gate
└── utils/
    └── logger.ts                   # Structured logging (pino)
tests/
├── unit/                           # Unit tests (vitest)
docs/                               # Additional documentation
scripts/
└── health-check.sh                 # Bash pre-flight health check
```
