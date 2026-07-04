# Elastic LLM Benchmarker

Autonomous LLM qualification pipeline for Elastic Agent Builder. Discovers models from HuggingFace, deploys them on GPU VMs via vLLM, runs performance benchmarks and Kibana eval suites, and produces recommendation reports with a verdict (`support` / `investigate` / `reject`).

## Pipeline

```
HuggingFace ──▶ Discovery ──▶ Queue (ES) ──▶ Scheduler
                                                 │
                          ┌──────────────────────┤
                          ▼                      ▼
                    ┌───────────┐          ┌───────────┐
                    │  Stage 1  │──pass──▶ │  Stage 2  │
                    │  vLLM     │          │  Kibana   │
                    │  Perf     │          │  Evals    │
                    └───────────┘          └─────┬─────┘
                          │                      │
                          │               ┌──────┴──────┐
                          ▼               ▼             ▼
                    ┌───────────┐   ┌───────────┐ ┌──────────┐
                    │ Smoke Test│   │  Stage 3  │ │ Buildkite│
                    │ + CI Eval │   │ Reasoning │ │ CI Evals │
                    └───────────┘   └───────────┘ └──────────┘
                                          │
                                          ▼
                                   Recommendation
                                      Report
```

**Stages:**

1. **Stage 1 -- Performance Gate**: Deploys model on GPU VM via SSH + Docker, runs `vllm bench serve`. If ITL/throughput thresholds fail, emits `reject` and skips remaining stages.
2. **Smoke Test + CI Eval** (optional): Validates the deployed model (health, inference, tool-calling), then triggers Buildkite on-demand evals against the live vLLM endpoint.
3. **Stage 2 -- Quality Eval**: Runs `@kbn/evals` suites (tool_calls, skill_invocation, etc.) against the vLLM endpoint.
4. **Stage 3 -- Reasoning**: LLM reasons over Stage 1+2 results and raw OTel traces, producing improvement suggestions.
5. **Recommendation Report**: Structured document with verdict, confidence, metrics, eval scores, and suggestions. Stored in Elasticsearch.

## Quick Start

```bash
git clone https://github.com/patrykkopycinski/elastic-llm-benchmarker.git
cd elastic-llm-benchmarker
npm install

# Configure
cp config/default.json config/local.json
# Edit config/local.json with your ES, SSH, and HuggingFace credentials

# Verify connectivity
npx tsx src/cli.ts health-check

# Enqueue a model
npx tsx src/cli.ts enqueue Qwen/Qwen2.5-7B-Instruct

# Start the scheduler (processes queue entries)
npx tsx src/cli.ts start \
  --config config/local.json \
  --stage2 \
  --stage3 \
  --discovery \
  --ci-evals
```

## CLI Reference

The CLI has two binaries that share the same entry point (`src/cli.ts`):

### `benchmarker-queue` (primary daemon)

| Command | Description |
|---------|-------------|
| `start` | Start the scheduler polling loop |
| `queue <modelId>` | Add a model to the benchmark queue |
| `enqueue <modelId>` | Enqueue with hardware-fit dry-run |
| `stop` | Stop the running daemon |
| `health-check` | Run health checks (ES, SSH, GPU VM) |
| `reasoning <runId>` | Run Stage 3 reasoning on a completed run |
| `setup-local` | Start local ES + EDOT containers |

#### `start` Options

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | `config/default.json` | Configuration file path |
| `--poll-interval <ms>` | `30000` | Queue polling interval |
| `--stage2` | `false` | Enable Kibana eval pipeline |
| `--stage3` | `true` | Enable LLM reasoning |
| `--discovery` | `false` | Enable HuggingFace model discovery |
| `--ci-evals` | `false` | Enable CI eval pipeline (smoke test + Buildkite) |
| `--full-eval` | `false` | Also trigger weekly evals after on-demand passes |
| `--connector <type>` | `elasticsearch` | Output connector (`elasticsearch` or `local`) |
| `--output-dir <path>` | `./benchmark-output` | Output directory for local connector |

### General commands

| Command | Description |
|---------|-------------|
| `status` | View queue depth, current model, result counts |
| `results` | Query benchmark results from ES |
| `recommend` | Get recommendation reports by model or verdict |
| `export` | Export results as JSON or CSV |
| `benchmark-model <id>` | Enqueue with priority and optionally wait for completion |
| `queue-status [id]` | View queue entries |
| `print-deploy-command` | Print vLLM docker run command for a model |
| `tool-call-benchmark` | Run tool-call benchmark against a running API |

## Configuration

### Config File (`config/default.json`)

```jsonc
{
  "ssh": {
    "host": "your-gpu-vm-host",
    "port": 22,
    "username": "your_ssh_user",
    "privateKeyPath": "/path/to/your/ssh/key"
  },
  "huggingfaceToken": "",
  "hardwareProfileId": "2xa100-80gb",
  "vmHardwareProfile": {
    "gpuType": "nvidia-a100-80gb",
    "gpuCount": 2,
    "ramGb": 340,
    "cpuCores": 24,
    "diskGb": 1000,
    "machineType": "a2-ultragpu-2g"
  },
  "engine": {
    "type": "vllm",
    "vllmGpuMemoryUtilization": 0.95
  },
  "benchmarkThresholds": {
    "minContextWindow": 128000,
    "maxITLMs": 20,
    "maxToolCallLatencyMs": 1000,
    "minToolCallSuccessRate": 1.0,
    "concurrencyLevels": [1, 4, 16],
    "healthCheckTimeoutSeconds": 1800
  },
  "smokeTest": {
    "healthTimeoutMs": 10000,
    "inferenceTimeoutMs": 30000,
    "toolCallingTimeoutMs": 60000,
    "maxRetries": 2,
    "depth": "full"           // "health" | "inference" | "full"
  },
  "buildkite": {
    "enabled": false,
    "apiToken": "",            // BUILDKITE_API_TOKEN env var
    "orgSlug": "elastic",
    "onDemandPipelineSlug": "kibana-evals-on-demand",
    "weeklyPipelineSlug": "kibana-evals-weekly-llm-evals",
    "pollIntervalMs": 30000,
    "pollTimeoutMs": 3600000,
    "retryOnFailure": true,
    "defaultEvalSuites": ["security_ai_assistant"],
    "kibanaBranch": "main",
    "triggerFullEval": false
  }
}
```

### Key Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SSH_HOST` | Yes | GPU VM IP address |
| `SSH_USERNAME` | Yes | SSH user |
| `SSH_PRIVATE_KEY_PATH` | Yes | Path to SSH private key |
| `ELASTICSEARCH_URL` | Yes | Elasticsearch cluster URL |
| `ELASTICSEARCH_API_KEY` | Recommended | ES API key |
| `HUGGINGFACE_TOKEN` | For discovery | HuggingFace API token |
| `BUILDKITE_API_TOKEN` | For CI evals | Buildkite REST API token |
| `ANTHROPIC_API_KEY` | For Stage 3 | LLM reasoning API key |
| `ES_GOLDEN_API_KEY` | For forwarding | Golden cluster API key |

## Elasticsearch Indices

| Index | Purpose |
|-------|---------|
| `benchmarker-results` | Stage 1 benchmark results (metrics, hardware, vLLM config) |
| `benchmarker-queue` | Work queue entries |
| `benchmarker-eval-reports` | Evaluation classification reports |
| `benchmark-evaluations` | Stage 2 eval suite results |
| `benchmark-stage2` | Stage 2 detailed results |
| `benchmark-reasoning` | Stage 3 reasoning suggestions |
| `recommendation-reports` | Final recommendation reports (verdict + evidence) |
| `benchmarker-ci-evals` | CI evaluation results (Buildkite) |
| `benchmarker-checkpoints` | Deployment lifecycle events |
| `benchmarker-errors` | Dead-letter queue for errors |

## API Endpoints

The dashboard server runs on port 3200 by default.

### Dashboard
- `GET /` -- Web dashboard (queue, leaderboard, methodology, vLLM commands)

### Queue Management
- `GET /api/v1/queue` -- List queue entries (`?status=`, `?limit=`, `?sort=`)
- `POST /api/v1/queue` -- Enqueue a model `{ modelId, priority?, metadata? }`
- `POST /api/v1/queue/:id/cancel` -- Cancel a queue entry
- `POST /api/v1/queue/:id/retry` -- Retry a failed entry
- `GET /api/v1/queue/current` -- Currently processing entry

### Results & Models
- `GET /api/v1/results` -- Benchmark results (`?limit=`, `?modelId=`)
- `GET /api/stats` -- Run counts (total, passed, failed)
- `GET /api/models` -- Model catalog with summaries
- `GET /api/recommendations` -- Recommendation reports

### Health & Monitoring
- `GET /healthz` -- Liveness probe (ES ping)
- `GET /api/v1/health` -- Comprehensive health with check details
- `GET /metrics` -- Prometheus-format metrics

## Hardware Profiles

Pre-defined profiles match common GPU configurations:

| Profile ID | GPUs | VRAM | Use Case |
|------------|------|------|----------|
| `2xa100-80gb` | 2x A100-80GB | 160 GB | Default: 70B+ models |
| `1xa100-80gb` | 1x A100-80GB | 80 GB | 7B-30B models |
| `4xa100-80gb` | 4x A100-80GB | 320 GB | 200B+ models |
| `1xl4` | 1x L4 | 24 GB | Small models |
| `8xl4` | 8x L4 | 192 GB | Large models on L4 |

The hardware estimator checks if a model fits the configured profile before queueing.

## Development

```bash
npm install
npx tsc --noEmit          # type check
npx vitest run            # unit tests (858 tests)
npm run build             # build for production
```

### Project Structure

```
src/
  cli.ts                              # CLI entry point (commander)
  api/queue-server.ts                 # Express API + dashboard server
  scheduler/
    scheduler.ts                      # Pipeline orchestrator (queue -> stages -> report)
    pipeline-state.ts                 # Pipeline run state machine
  worker/
    stage1-worker.ts                  # SSH -> GPU VM -> vLLM deploy -> benchmark
    stage2-worker.ts                  # Kibana @kbn/evals runner
    stage2-gate.ts                    # Stage 1 pass/fail gate
    stage3-worker.ts                  # LLM reasoning over traces
  services/
    elasticsearch-results-store.ts    # ES persistence (all data)
    queue-service.ts                  # ES-backed work queue
    ssh-client.ts                     # SSHClientPool
    vllm-deployment.ts                # Docker deploy on GPU VM
    model-discovery.ts                # HuggingFace API polling
    discovery-scheduler.ts            # Periodic discovery + auto-queue
    hardware-estimator.ts             # VRAM estimation
    hardware-profiles.ts              # Predefined GPU profiles
    model-smoke-test.ts               # 3-tier model validation
    buildkite-eval-trigger.ts         # Buildkite REST API integration
    buildkite-connector-builder.ts    # KIBANA_TESTING_AI_CONNECTORS builder
    golden-forwarder.ts               # Async replication to shared ES
    recommendation-report-builder.ts  # Verdict computation
    hf-card-parser.ts                 # HuggingFace model card parsing
    es-index-mappings.ts              # ES index definitions
  types/
    config.ts                         # Zod-validated AppConfig
    ci-eval.ts                        # CI evaluation result type
    benchmark.ts                      # Benchmark result type
    recommendation.ts                 # Recommendation report type
tests/
  unit/                               # 858 unit tests (vitest)
  integration/                        # Integration tests
```

See [docs/architecture.md](docs/architecture.md) for detailed data flow and service interactions, and [docs/runbook.md](docs/runbook.md) for operational procedures.
