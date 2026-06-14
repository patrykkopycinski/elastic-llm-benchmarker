# elastic-llm-benchmarker

Automated LLM discovery, deployment, benchmarking, and evaluation agent powered by the Elastic Stack. The benchmarker discovers models from HuggingFace, deploys them via vLLM on GPU VMs, runs latency/throughput/tool-call benchmarks, executes Kibana eval suites, and generates LLM-driven reasoning suggestions — all results stored in Elasticsearch with Kibana dashboards.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
  - [`benchmarker-queue`](#benchmarker-queue)
  - [`elbench`](#elbench)
- [Configuration Reference](#configuration-reference)
- [Operational Runbook](#operational-runbook)
- [Development Guide](#development-guide)
- [Contributing](#contributing)
- [License](#license)

---

## Architecture Overview

The benchmarker is a three-stage pipeline orchestrated by a polling scheduler. Each stage is idempotent, state-backed by Elasticsearch indices, and observable via Kibana.

### Pipeline Stages

| Stage | Name | Description | Gate |
|-------|------|-------------|------|
| **Stage 1** | Deploy & Benchmark | Dequeue model → fetch HF config → deploy via SSH/vLLM → run `vllm bench serve` → store ITL, TTFT, throughput, tool-call metrics | None |
| **Stage 2** | Eval | Gate on Stage 1 thresholds → clone/bootstrap Kibana repo → run eval suites (`tool_calls`, `latency`) → emit OTLP traces → store scores | `stage2Thresholds` (ITL, throughput, TTFT, context window) |
| **Stage 3** | Reasoning | Query traces with ES\|QL → build structured prompt with Stage 1 + Stage 2 results + vLLM config → call LLM → generate actionable suggestions | Always runs after Stage 2 (or after Stage 1 if Stage 2 skipped) |

### Key Services

| Service | Responsibility |
|---------|----------------|
| **Scheduler** | Polls `benchmarker-queue`, coordinates Stage 1 → 2 → 3 transitions, manages concurrency (default: 1 run at a time) |
| **QueueService** | ES-backed queue (`pending`, `running`, `completed`, `failed`) with priority ordering |
| **ModelDiscovery** | Polls HuggingFace Hub API (respecting rate limits), scores by trending + recency, filters by `pipeline_tag` and hardware fit |
| **HardwareEstimator** | Parses `config.json` params × layers × dtype → estimated GPU memory; compares against hardware profiles |
| **SSHClientPool** | Reusable SSH connections to the GPU VM for Docker management and remote commands |
| **VLLMDeployment** | Generates vLLM Docker run commands with tool-call parser auto-detection, max-model-len inference, and tensor-parallel sizing |
| **ElasticsearchResultsStore** | Writes/reads all benchmark, eval, reasoning, and queue documents |
| **EvalSuiteRunner** | Executes Kibana eval suites against the deployed vLLM endpoint; forwards traces to EDOT collector |
| **TraceQueryBuilder** | Builds ES\|QL queries over `.benchmark-traces-*` for failure patterns and latency breakdowns |
| **ReasoningPromptBuilder** | Composes structured prompts for the reasoning LLM using Stage 1/2 results and trace summaries |
| **LLMClient** | OpenAI-compatible client for reasoning (configurable base URL, model, temperature, max tokens) |
| **GoldenForwarder** | Conditionally replicates results + traces to a golden ES cluster for centralized tracking |
| **KibanaRepoService** | Clones/caches Kibana repo, runs bootstrap, pins to commits/tags |
| **KibanaConnector** | Creates OpenAI-compatible Kibana connectors pointing to the tunneled vLLM endpoint |
| **HealthCheck** | Pre-flight script verifying local ES, EDOT collector, and GPU VM reachability |

### Elasticsearch Indices

| Index | Purpose |
|-------|---------|
| `benchmarker-results` | Stage 1 benchmark metrics (ITL, TTFT, throughput, P99, tool-call success rate) |
| `benchmarker-eval-reports` | Evaluation report summaries |
| `benchmarker-queue` | Work queue entries with source, priority, and hardware profile metadata |
| `benchmarker-checkpoints` | Deployment lifecycle events (start, stop, errors) |
| `benchmarker-models` | Discovered HF model catalog with parsed configs |
| `benchmarker-errors` | Error and retry events |
| `benchmark-evaluations` | Detailed evaluation results from eval suites |
| `benchmark-stage2` | Stage 2 gate decisions and eval artifacts |
| `benchmark-reasoning` | Stage 3 LLM suggestions and trace summaries |

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

Requires Node.js >= 20.

### 2. Configure environment

Copy the example file and edit:

```bash
cp .env.example .env
```

Minimal `.env` for local ES + single GPU VM:

```bash
# SSH to GPU VM
SSH_HOST=your.vm.ip
SSH_PORT=22
SSH_USERNAME=your_ssh_user
SSH_PRIVATE_KEY_PATH=/Users/patryk/.ssh/id_rsa

# HuggingFace
HUGGINGFACE_TOKEN=hf_your_token

# Local Elasticsearch
ELASTICSEARCH_URL=http://localhost:9200

# VM hardware (overridden by HARDWARE_PROFILE_ID if set)
VM_GPU_TYPE=nvidia-l4
VM_GPU_COUNT=1
VM_RAM_GB=64
VM_CPU_CORES=8
VM_DISK_GB=200

# Stage 2 (optional)
STAGE2_MIN_ITL_P50_MS=20
STAGE2_MIN_THROUGHPUT_TPS=10
STAGE2_MAX_TTFT_MS=5000
STAGE2_MIN_CONTEXT_WINDOW=128000

# Stage 3 reasoning LLM
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o

# Golden cluster (optional)
GOLDEN_CLUSTER_ENABLED=false
GOLDEN_CLUSTER_URL=https://your-golden-cluster.kb.cloud.es.io
GOLDEN_CLUSTER_API_KEY=
GOLDEN_CLUSTER_FORWARD_TO_GOLDEN=false
```

Optionally, create a `config/default.json` for structured config (see [Configuration Reference](#configuration-reference)). Environment variables override JSON values.

### 3. Bootstrap local infrastructure

```bash
npm run setup
```

This runs `scripts/setup-local.sh` (starts Elasticsearch + EDOT containers and creates indices) followed by `scripts/setup-ilm.sh` (configures ILM policies).

### 4. Build

```bash
npm run build:ts
```

Or build the LangGraph Docker image:

```bash
npm run build
```

### 5. Start the pipeline

```bash
benchmarker-queue start --stage2 --stage3
```

Or enqueue a model manually:

```bash
benchmarker-queue queue meta-llama/Llama-3.2-1B-Instruct -p 10
```

---

## CLI Reference

The project exposes two CLI binaries:

- **`benchmarker-queue`** — Scheduler, queue management, and pipeline operations.
- **`elbench`** (also `elastic-llm-benchmarker`) — Querying, exporting, and utility commands.

### `benchmarker-queue`

#### `start`

Start the scheduler polling loop for pending queue entries.

```bash
benchmarker-queue start [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-c, --config <path>` | `config/default.json` | Path to configuration file |
| `--poll-interval <ms>` | `30000` | Queue polling interval |
| `--stage2` | `false` | Enable Stage 2 eval pipeline |
| `--stage3` | `true` | Enable Stage 3 reasoning pipeline |
| `--queue-model <modelId>` | — | Enqueue a single model and exit (CI mode) |

Examples:

```bash
# Full pipeline
benchmarker-queue start --stage2 --stage3

# CI one-off
benchmarker-queue start --queue-model meta-llama/Llama-3.2-1B-Instruct
```

#### `queue`

Add a model to the benchmark queue.

```bash
benchmarker-queue queue <modelId> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-c, --config <path>` | `config/default.json` | Path to configuration file |
| `-p, --priority <n>` | `5` | Queue priority (higher runs first) |
| `-s, --source <source>` | `user` | Entry source (`user` or `discovery`) |

Example:

```bash
benchmarker-queue queue meta-llama/Llama-3.2-1B-Instruct -p 10
```

#### `reasoning`

Run Stage 3 reasoning on a completed benchmark run.

```bash
benchmarker-queue reasoning <runId> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-c, --config <path>` | `config/default.json` | Path to configuration file |
| `-m, --model <modelId>` | `runId` | Model identifier |

#### `health-check`

Run pre-flight health checks for ES, EDOT, and GPU VM.

```bash
benchmarker-queue health-check
```

#### `setup-local`

Start local ES + EDOT containers and configure ILM policies.

```bash
benchmarker-queue setup-local
```

#### `stop`

Stop the running scheduler daemon.

```bash
benchmarker-queue stop
```

### `elbench`

#### `status`

View benchmarker status from Elasticsearch (results counts, queue state, current run).

```bash
elbench status
```

#### `results`

Query stored benchmark results.

```bash
elbench results [options]
```

| Option | Description |
|--------|-------------|
| `--model <id>` | Filter by model ID |
| `--status <passed\|failed>` | Filter by status |
| `--after <date>` | Filter after date (ISO 8601) |
| `--before <date>` | Filter before date (ISO 8601) |
| `--gpu-type <type>` | Filter by GPU type |
| `--limit <n>` | Max results (default: 20) |
| `--offset <n>` | Skip N results |
| `--order <asc\|desc>` | Sort order (default: desc) |
| `--summary` | Show per-model summary instead of individual runs |

#### `export`

Export results as JSON or CSV.

```bash
elbench export [options]
```

| Option | Description |
|--------|-------------|
| `--format <json\|csv>` | Output format (default: json) |
| `--output <path>` | Output file (default: stdout) |
| `--model`, `--status`, `--after`, `--before`, `--gpu-type` | Same filters as `results` |

#### `kibana-import`

Import Kibana saved objects (dashboards, visualizations, index patterns).

```bash
elbench kibana-import
```

#### `bootstrap-kibana`

Clone and bootstrap the Kibana repository for eval suites.

```bash
elbench bootstrap-kibana
```

#### `print-deploy-command`

Print a vLLM Docker run command with auto-detected tool calling for a model.

```bash
elbench print-deploy-command --model <modelId> [--port <n>] [--tensor-parallel <n>]
```

#### `tool-call-benchmark`

Run the tool-call benchmark against a running vLLM endpoint.

```bash
elbench tool-call-benchmark --base-url <url> --model <modelId>
```

#### `deploy-and-test-tool-calls`

Deploy vLLM locally with tool calling, wait for healthy, run benchmark, then optionally stop.

```bash
elbench deploy-and-test-tool-calls --model <modelId> [--no-stop]
```

#### `migrate-to-es`

Migrate legacy SQLite results to Elasticsearch.

```bash
elbench migrate-to-es --db <path>
```

---

## Configuration Reference

Configuration is loaded from `config/default.json` (or `--config`) and overridden by environment variables. The precedence is: CLI flag > environment variable > JSON config > built-in default.

### Top-Level Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ssh` | object | required | SSH connection to GPU VM (see below) |
| `huggingfaceToken` | string | required | HuggingFace API token |
| `benchmarkThresholds` | object | `{}` | Stage 1 pass/fail thresholds (see below) |
| `vmHardwareProfile` | object | `{}` | Target VM specs (see below) |
| `hardwareProfileId` | string | — | Select a built-in profile (`1xl4`, `2xa100-80gb`, etc.) |
| `logLevel` | string | `info` | `error`, `warn`, `info`, or `debug` |
| `resultsDir` | string | `./results` | Local results directory |
| `daemon` | object | `{}` | Continuous runner settings (see below) |
| `tunnel` | object | `{}` | Public API tunnel config (ngrok) |
| `engine` | object | `{}` | Inference engine settings (vLLM / Ollama) |
| `kibanaConnector` | object | `{}` | Auto-create Kibana connectors |
| `notifications` | object | `{}` | Event notifications (console, file, webhook, email) |
| `kibanaEval` | object | `{}` | Eval runner settings |
| `elasticsearch` | object | `{}` | Primary ES connection |
| `elasticAgent` | object | `{}` | Elastic Agent fleet enrollment |
| `stage2Thresholds` | object | `{}` | Gate between Stage 1 and Stage 2 |
| `enableStage2` | boolean | `false` | Global Stage 2 toggle |
| `goldenCluster` | object | `{}` | Centralized ES cluster forwarding |
| `edotCollector` | object | `{}` | OpenTelemetry trace collector settings |
| `kibanaRepo` | object | `{}` | Kibana git repo config |
| `discoveryScheduler` | object | `{}` | Automated HF discovery settings |
| `llmApiKey` | string | — | API key for reasoning LLM |
| `llmBaseUrl` | string | — | OpenAI-compatible base URL |
| `llmModel` | string | `gpt-4o` | Reasoning model name |
| `llmMaxTokens` | number | `4096` | Max tokens for reasoning |
| `llmTemperature` | number | `0.3` | Sampling temperature |

### `ssh`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | string | required | VM hostname or IP |
| `port` | number | `22` | SSH port |
| `username` | string | required | SSH username |
| `password` | string | — | SSH password (or use `privateKeyPath`) |
| `privateKeyPath` | string | — | Path to SSH private key |
| `useSudo` | boolean | `false` | Run Docker commands with sudo |

### `benchmarkThresholds`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `minContextWindow` | number | `128000` | Minimum supported context length |
| `maxITLMs` | number | `20` | Base max inter-token latency (ms) |
| `maxITLMsTiers` | array | `[{14B:20}, {40B:40}, {80B:60}, {∞:100}]` | Tiered ITL thresholds by parameter count |
| `maxToolCallLatencyMs` | number | `1000` | Max tool-call latency threshold |
| `minToolCallSuccessRate` | number | `1.0` | Min tool-call success rate (0–1) |
| `concurrencyLevels` | number[] | `[1, 4, 16]` | Benchmark concurrency levels |
| `healthCheckTimeoutSeconds` | number | `1200` | Max warmup time before abort |

### `vmHardwareProfile`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `gpuType` | string | `nvidia-l4` | GPU model identifier |
| `gpuCount` | number | `1` | Number of GPUs |
| `ramGb` | number | `64` | System RAM (GB) |
| `cpuCores` | number | `8` | CPU core count |
| `diskGb` | number | `200` | Disk space (GB) |
| `machineType` | string | `g2-standard-8` | Cloud machine type |

### `stage2Thresholds`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `minItlP50Ms` | number | `20` | Max ITL P50 (ms) to pass gate |
| `minThroughputTps` | number | `10` | Min throughput (tok/s) to pass gate |
| `maxTtftMs` | number | `5000` | Max TTFT (ms) to pass gate |
| `minContextWindow` | number | `128000` | Min context window to pass gate |

### `engine`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | string | `vllm` | `vllm` or `ollama` |
| `apiPort` | number | `8000` / `11434` | Inference API port |
| `dockerImage` | string | — | Override Docker image |
| `ollamaUseDocker` | boolean | `false` | Use Docker for Ollama |
| `ollamaNumGpuLayers` | number | `-1` | GPU layers for Ollama (`-1` = all) |
| `vllmGpuMemoryUtilization` | number | `0.9` | GPU memory fraction for vLLM |
| `maxModelLen` | number | — | Override max model length |

### `discoveryScheduler`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable automated discovery |
| `intervalMinutes` | number | `60` | Minutes between discovery runs |
| `maxModelsPerRun` | number | `10` | Max models to enqueue per run |
| `minTrendingScore` | number | `50` | Min trending score (0–100) |
| `autoQueue` | boolean | `true` | Automatically enqueue discovered models |
| `hardwareProfileId` | string | `1xl4` | Profile used for dry-run fit checks |

### Built-in Hardware Profiles

| ID | Display Name | GPU | RAM | CPU | Machine Type |
|----|--------------|-----|-----|-----|--------------|
| `1xl4` | 1x NVIDIA L4 | 1× L4 | 64 GB | 8 | `g2-standard-8` |
| `8xl4` | 8x NVIDIA L4 | 8× L4 | 384 GB | 96 | `g2-standard-96` |
| `1xa100-80gb` | 1x NVIDIA A100 80GB | 1× A100 | 340 GB | 12 | `a2-highgpu-1g` |
| `2xa100-80gb` | 2x NVIDIA A100 80GB | 2× A100 | 680 GB | 24 | `a2-ultragpu-2g` |
| `4xa100-80gb` | 4x NVIDIA A100 80GB | 4× A100 | 1360 GB | 48 | `a2-ultragpu-4g` |

---

## Operational Runbook

### Starting the Pipeline

1. Run the health check:
   ```bash
   benchmarker-queue health-check
   ```

2. Start local infrastructure (if not already running):
   ```bash
   npm run setup
   ```

3. Start the scheduler with desired stages:
   ```bash
   benchmarker-queue start --stage2 --stage3
   ```

The scheduler acquires a lockfile (`.benchmarker-queue.lock`) and polls the queue every 30 seconds. Press `Ctrl+C` for graceful shutdown.

### Manual Model Override

To bypass discovery and immediately benchmark a specific model:

```bash
benchmarker-queue queue <modelId> -p 10
```

If the model does not pass the hardware-fit dry-run, the enqueue will fail with an estimate. Use `HARDWARE_PROFILE_ID` to target a different VM class.

### Checking Pipeline Status

Quick status overview:

```bash
elbench status
```

Query recent results:

```bash
elbench results --limit 5 --summary
```

View logs and dashboards:

- **Kibana**: http://localhost:5601
- Import dashboards: `elbench kibana-import`
- Saved objects are in `dashboard/benchmarker-dashboard.ndjson`.

### Reading Stage 3 Reasoning Results

Reasoning documents are stored in the `benchmark-reasoning` index. Each document contains:

- `runId` / `modelId`
- `esqlQueries` — the trace queries executed
- `traceSummary` — aggregated trace stats
- `suggestions` — structured LLM output (prompt changes, quantization, hardware switch, etc.)

Query via Kibana Discover on `benchmark-reasoning` or via Dev Tools:

```json
GET benchmark-reasoning/_search
{
  "query": { "term": { "runId": "your-run-id" } }
}
```

Run reasoning manually for a completed run:

```bash
benchmarker-queue reasoning <runId>
```

### Golden Cluster Forwarding

Enable to replicate results and traces to a centralized cluster:

```bash
# .env
GOLDEN_CLUSTER_ENABLED=true
GOLDEN_CLUSTER_URL=https://your-cluster.kb.cloud.es.io
GOLDEN_CLUSTER_API_KEY=your-api-key
GOLDEN_CLUSTER_FORWARD_TO_GOLDEN=true
```

When `forwardToGolden` is `true`, every completed run is replicated without affecting local pipeline latency. Disable if you only need local tracking.

### Common Issues and Troubleshooting

#### OOM during vLLM deployment

- Reduce `VLLM_GPU_MEMORY_UTILIZATION` (default `0.9`).
- Override `ENGINE_MAX_MODEL_LEN` to a smaller value.
- Switch to a larger hardware profile (`2xa100-80gb`, `4xa100-80gb`).

#### SSH failures

- Verify the VM is reachable: `ssh -i <key> <user>@<host>`
- Ensure `SSH_PRIVATE_KEY_PATH` or `SSH_PASSWORD` is set.
- If Docker requires sudo, set `SSH_USE_SUDO=true`.

#### HF rate limits

- Set `HUGGINGFACE_TOKEN` for authenticated (higher) rate limits.
- Discovery scheduler respects a 1 req/min pacing; increase `intervalMinutes` if needed.

#### Stage 2 eval failures

- Kibana bootstrap can take 20–30 minutes on first run. The repo is cached at `./.kibana-cache`.
- Ensure `KIBANA_REPO_PIN_TO_COMMIT` or `KIBANA_REPO_PIN_TO_TAG` points to a stable ref.
- Eval failures are logged as `eval error`; they do not fail the pipeline.

#### Elasticsearch connection errors

- Verify the local stack: `curl http://localhost:9200/_cluster/health`
- Ensure `setup-local.sh` completed successfully (indices created).
- For Elastic Cloud, use `ELASTICSEARCH_CLOUD_ID` + `ELASTICSEARCH_API_KEY` instead of `ELASTICSEARCH_URL`.

### Extending Hardware Profiles

Built-in profiles are defined in `src/services/hardware-profiles.ts`. Add a custom profile at runtime in code by calling:

```typescript
import { HardwareProfileRegistry } from './services/hardware-profiles.js';

const registry = new HardwareProfileRegistry();
registry.registerProfile({
  id: 'custom-a60',
  displayName: '1x NVIDIA A60',
  description: 'Custom A60 configuration',
  hardware: {
    gpuType: 'nvidia-a60',
    gpuCount: 1,
    ramGb: 128,
    cpuCores: 16,
    diskGb: 500,
    machineType: 'custom-type',
  },
});
```

---

## Development Guide

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start LangGraph dev server |
| `npm run build:ts` | Build TypeScript to `dist/` |
| `npm run build` | Build LangGraph Docker image |
| `npm run setup` | Start local ES + EDOT + ILM |
| `npm run typecheck` | TypeScript type checking (`tsc --noEmit`) |
| `npm run test` | Run tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage |
| `npm run lint` | ESLint |
| `npm run lint:fix` | ESLint with auto-fix |
| `npm run format` | Prettier formatting |
| `npm run format:check` | Prettier check |
| `npm run infra:up` | Start ES + Kibana via Docker Compose |
| `npm run infra:down` | Stop Docker Compose |
| `npm run infra:reset` | Stop and remove volumes (data wiped) |

### Testing

- **Unit tests**: Mocked ES, SSH, and HF responses.
- **Integration tests**: Require local ES running (`npm run setup`).
- **E2E test**: Full pipeline with `--queue-model` on a small model (e.g., `gpt2`).

Run the full suite:

```bash
npm run typecheck
npm run lint
npm run test
```

### Project Structure

```
├── src/
│   ├── cli.ts              # Entry point for elbench + benchmarker-queue
│   ├── cli/                # CLI handlers
│   ├── scheduler/          # Polling scheduler + pipeline state machine
│   ├── worker/             # Stage 1, Stage 2, Stage 3 workers
│   ├── services/           # ES store, queue, SSH, discovery, eval, reasoning
│   ├── engines/            # vLLM and Ollama deployment logic
│   ├── types/              # Zod schemas + TypeScript types
│   ├── config/             # Config loader
│   └── utils/              # Logger, lockfile, etc.
├── scripts/                # Shell scripts for setup, health-check, dashboards
├── config/                 # Default JSON + Kibana + OTel configs
├── dashboard/              # Exported Kibana dashboards (.ndjson)
├── tests/                  # Vitest test suites
└── docker-compose.yml      # Local ES + Kibana stack
```

---

## Contributing

Contributions are welcome. Please open an issue or pull request on the project repository.

- Follow the existing TypeScript and ESLint conventions.
- Write tests for new features.
- Update this README when adding new CLI commands or configuration options.

---

## License

MIT
