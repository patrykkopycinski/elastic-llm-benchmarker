# Architecture

## System Overview

The Elastic LLM Benchmarker is a daemon service that autonomously discovers, benchmarks, and evaluates open-source LLMs for Elastic Agent Builder support decisions. It runs as a single Node.js process that coordinates work across a GPU VM (via SSH), Elasticsearch (for persistence), HuggingFace (for discovery), and optionally Buildkite (for CI evaluations).

```
                                        ┌──────────────────┐
                                        │   HuggingFace    │
                                        │   API            │
                                        └────────┬─────────┘
                                                 │ model metadata
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Benchmarker Daemon (Node.js)                       │
│                                                                             │
│  ┌──────────────┐    ┌──────────┐    ┌──────────────────────────────────┐   │
│  │  Discovery    │───▶│  Queue   │───▶│          Scheduler              │   │
│  │  Scheduler    │    │ Service  │    │                                  │   │
│  └──────────────┘    └──────────┘    │  Stage 1 ──▶ Smoke ──▶ CI Eval  │   │
│                                       │     │          Test    (Buildkite)│   │
│                                       │     ▼                            │   │
│                                       │  Stage 2 ──▶ Stage 3            │   │
│                                       │     │          │                 │   │
│                                       │     ▼          ▼                 │   │
│                                       │  Recommendation Report           │   │
│                                       └──────────────────────────────────┘   │
│                                                                             │
│  ┌───────────┐  ┌────────────┐  ┌───────────────┐  ┌──────────────────┐    │
│  │ SSH Pool  │  │ Results    │  │ Golden        │  │ Slack Notifier   │    │
│  │           │  │ Store (ES) │  │ Forwarder     │  │                  │    │
│  └─────┬─────┘  └──────┬─────┘  └───────┬───────┘  └──────────────────┘    │
└────────┼───────────────┼────────────────┼──────────────────────────────────┘
         │               │                │
         ▼               ▼                ▼
   ┌───────────┐  ┌──────────────┐  ┌──────────────┐
   │  GPU VM   │  │ Elasticsearch│  │ Golden ES    │
   │ (Docker + │  │ (Serverless) │  │ (shared,     │
   │  vLLM)    │  │              │  │  write-only) │
   └───────────┘  └──────────────┘  └──────────────┘
```

## Core Design Principles

1. **Elasticsearch is the single source of truth.** No SQLite, no local state files for data. Queue, results, traces, models, errors, recommendations -- all live in ES.

2. **Never throw in services.** All service methods return structured results: `{ success, error?, data? }`. Errors are logged and returned, never thrown.

3. **Scheduler owns the model lifecycle.** The scheduler deploys a model (via Stage 1), keeps it alive for optional smoke tests and CI evals, then tears it down in a `finally` block. Workers never tear down models.

4. **Forward-only shared cluster.** The golden ES cluster is write-only. We forward recommendation reports and eval traces; we never read from it.

5. **SSH as black box.** The GPU VM is reached only via `SSHClientPool`. No direct SSH calls outside this service.

## Data Flow

### Pipeline execution (per model)

```
1. Queue entry claimed (status: pending → deploying)
      │
2. Stage 1: SSH → GPU VM → docker run vllm → vllm bench serve
      │  Produces: BenchmarkResult (metrics, hardware config, vLLM command)
      │  Gate: ITL p50 < threshold AND throughput > threshold
      │
      ├─ FAIL → Recommendation Report (verdict: reject) → done
      │
      ├─ PASS → Model stays deployed for optional stages:
      │
      ├─ Smoke Test (if --ci-evals)
      │    Tier 1: Health check (/health endpoint)
      │    Tier 2: Inference check (simple completion)
      │    Tier 3: Tool-calling check (structured function call)
      │      │
      │      └─ Buildkite CI Eval
      │           Build connector JSON (base64-encoded .gen-ai config)
      │           Trigger on-demand eval build
      │           Poll for completion (30s intervals, 1h timeout)
      │           Fetch artifacts
      │           Retry once on failure (if configured)
      │           Optional: trigger weekly eval if on-demand passes
      │
3. Stage 2: Kibana @kbn/evals against the live vLLM endpoint
      │  Produces: EvalResult (per-suite scores, pass/fail)
      │
4. Stage 3: LLM reasoning over Stage 1 + Stage 2 + OTel traces
      │  Produces: Suggestions (config changes, prompt tweaks)
      │
5. Recommendation Report assembled
      │  Verdict: support / investigate / reject
      │  Stored in recommendation-reports index
      │
6. Teardown: scheduler finally block stops vLLM container
      │
7. Notifications: Slack webhook on support/investigate
      │
8. Golden forwarding: async batch replication of report to shared cluster
```

### Discovery flow

```
HuggingFace API
      │
      ▼
ModelDiscoveryService
  - Searches for text-generation models
  - Filters: license, downloads, recency
  - Parses model cards for vLLM config hints
      │
      ▼
HardwareEstimator
  - Estimates VRAM usage from parameter count + quantization
  - Checks against configured hardware profile
      │
      ├─ Does not fit → skip
      │
      └─ Fits → QueueService.enqueue()
                 source: "discovery"
                 priority: 0 (lower than manual)
```

## Service Architecture

### Scheduler (`src/scheduler/scheduler.ts`)

The central orchestrator. Polls the queue every N ms, claims one entry at a time, and sequences stages:

- Instantiates `Stage1Worker`, optionally `Stage2Worker` and `Stage3Worker`
- Owns model lifecycle: `vllmEngine.stop()` in `finally` block
- Runs CI eval pipeline between Stage 1 and Stage 2 (if enabled)
- Builds recommendation report from combined results
- Sends Slack notifications

### Workers

| Worker | File | Responsibility |
|--------|------|----------------|
| Stage1WorkerImpl | `src/worker/stage1-worker.ts` | SSH deploy vLLM, run benchmark, return metrics |
| Stage2WorkerImpl | `src/worker/stage2-worker.ts` | Clone Kibana, run eval suites, return scores |
| Stage2Gate | `src/worker/stage2-gate.ts` | Decide whether Stage 1 results pass the threshold |
| Stage3WorkerImpl | `src/worker/stage3-worker.ts` | Query traces, build prompt, call LLM, return suggestions |

### Services

| Service | File | Role |
|---------|------|------|
| `QueueService` | `src/services/queue-service.ts` | ES-backed work queue (enqueue, claim, complete, fail) |
| `ElasticsearchResultsStore` | `src/services/elasticsearch-results-store.ts` | All read/write to ES (results, reports, models, CI evals) |
| `SSHClientPool` | `src/services/ssh-client.ts` | Pooled SSH connections to GPU VM |
| `VllmDeploymentService` | `src/services/vllm-deployment.ts` | Docker deploy/stop on GPU VM |
| `VllmEngine` | `src/engines/vllm-engine.ts` | Adapter around VllmDeploymentService |
| `ModelDiscoveryService` | `src/services/model-discovery.ts` | HuggingFace API search + model card parsing |
| `DiscoveryScheduler` | `src/services/discovery-scheduler.ts` | Periodic discovery loop + auto-queue |
| `HardwareEstimator` | `src/services/hardware-estimator.ts` | VRAM estimation from model metadata |
| `ModelSmokeTestImpl` | `src/services/model-smoke-test.ts` | 3-tier model validation |
| `BuildkiteEvalTriggerImpl` | `src/services/buildkite-eval-trigger.ts` | Buildkite REST API (trigger, poll, artifacts) |
| `SlackNotifier` | `src/services/slack-notifier.ts` | Webhook notifications |
| `RecommendationReportBuilder` | `src/services/recommendation-report-builder.ts` | Verdict computation from stage results |

## Elasticsearch Index Design

### Core data indices

| Index | Key fields | Retention |
|-------|-----------|-----------|
| `benchmarker-results` | model_id, timestamp, hardware_config, benchmark_metrics, tool_call_results, docker_command | Long-term |
| `benchmarker-queue` | model_id, status, priority, requested_at, started_at, completed_at | Cleaned on completion |
| `recommendation-reports` | model_id, verdict, confidence, stage1_metrics, passing_evals, suggestions | Long-term |
| `benchmarker-ci-evals` | model_id, buildkite_build_url, status, eval_suites, scores, artifacts | Long-term |

### Operational indices

| Index | Key fields | Retention |
|-------|-----------|-----------|
| `benchmarker-models` | model_id, architecture, parameter_count, context_window, license | Append-only |
| `benchmarker-checkpoints` | model_id, event_type, container_id, error | 30 days |
| `benchmarker-errors` | error_category, error_message, recovery_action, circuit_breaker_state | 90 days |
| `benchmark-evaluations` | model_id, suite_results, scores | Long-term |
| `benchmark-reasoning` | model_id, suggestions, trace_summary | Long-term |

All indices are auto-created on startup via `ensureIndices()` in `ElasticsearchResultsStore`.

## vLLM Deployment Strategy

Models are deployed on the GPU VM as Docker containers:

```bash
docker run -d --gpus all \
  --name vllm-<model-slug> \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  -p 8000:8000 \
  --ipc=host \
  vllm/vllm-openai:latest \
  --model <model-id> \
  --tensor-parallel-size 2 \
  --gpu-memory-utilization 0.95 \
  --trust-remote-code \
  --enable-auto-tool-choice \
  --tool-call-parser <parser>
```

Key deployment decisions:
- **Always uses `latest` vLLM tag**: the actual version is resolved from the running container after deploy
- **Tensor parallel = GPU count**: maximizes throughput by sharding across all available GPUs
- **GPU memory utilization = 0.95**: maximizes the KV cache for longer sequences
- **No artificial context cap**: max model length is determined by the model's native config
- **Tool call parser**: auto-detected from model architecture (llama3_json, hermes, mistral, etc.)

## CI Eval Pipeline

When `--ci-evals` is enabled, the scheduler runs this flow after Stage 1 passes:

```
1. ModelSmokeTest.run(endpointUrl, modelId)
   ├─ Health: GET /health (with retries)
   ├─ Inference: POST /v1/chat/completions (simple prompt)
   └─ Tool calling: POST /v1/chat/completions (with tools)

2. buildConnectorJson(modelId, endpointUrl)
   └─ Produces base64-encoded KIBANA_TESTING_AI_CONNECTORS
      Format: .gen-ai connector with apiProvider: "Other"

3. BuildkiteEvalTrigger.triggerOnDemandEval(...)
   ├─ POST /v2/organizations/elastic/pipelines/<slug>/builds
   │   env: { KIBANA_TESTING_AI_CONNECTORS, EVAL_SUITES, ... }
   ├─ Poll GET /v2/.../builds/<number> every 30s (up to 1h)
   ├─ On failure + retryOnFailure: retry once
   └─ Fetch build artifacts

4. (Optional) BuildkiteEvalTrigger.triggerWeeklyEval(...)
   └─ Same flow against the weekly pipeline
```

Results are stored in the `benchmarker-ci-evals` index with the Buildkite build URL, status, scores, and artifacts.

## Error Handling

### Circuit breaker

The `CircuitBreaker` (`src/services/circuit-breaker.ts`) protects against repeated failures to external services:

- **CLOSED**: normal operation, requests pass through
- **OPEN**: after N consecutive failures, all requests fail fast for a reset period
- **HALF_OPEN**: after reset period, one request is allowed through to test recovery

Used by: SSH connections, ES operations, golden forwarding.

### Dead-letter queue

Failed operations that exhaust retries are written to the `benchmarker-errors` index with:
- Error category (ssh, vllm, es, discovery, api)
- Recovery action taken
- Attempt count
- Circuit breaker state at time of failure

### Graceful degradation

| Component failure | Impact | Recovery |
|------------------|--------|----------|
| ES unreachable | Queue polling stops, results not stored | Auto-retry with backoff |
| SSH to GPU VM fails | Stage 1 cannot deploy | Entry marked failed, next entry tried |
| vLLM OOM | Container exits | Entry marked failed with error details |
| HuggingFace API down | Discovery stops | Discovery scheduler retries on next interval |
| Buildkite API down | CI evals skipped | Logged, pipeline continues without CI results |
| Golden cluster 429 | Forwarding paused | Exponential backoff, then DLQ |

## Security

- **API keys are SHA-256 hashed** before storage in ES
- **SSH connections** use key-based auth only (no passwords in committed config)
- **Credentials** (`ES_API_KEY`, `SSH_PRIVATE_KEY_PATH`, `HF_TOKEN`, `BUILDKITE_API_TOKEN`) are loaded from config or env vars, never committed
- **Golden cluster** is write-only: no read queries, preventing data leakage
- **Rate limiting**: API server enforces 100 req/min per key (configurable)
