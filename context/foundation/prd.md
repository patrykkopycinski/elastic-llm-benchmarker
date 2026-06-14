---
project: Elastic LLM Benchmarker
version: 1.0
status: draft
authors: [patrykkopycinski]
date: 2026-06-14
related_docs:
  - frame.md
  - shape-notes.md
timeline:
  weeks: 4
  start: "2026-06-14"
---

# Product Requirements Document: Elastic LLM Benchmarker

## 1. Overview

The Elastic LLM Benchmarker is an autonomous evaluation pipeline that continuously discovers promising open-source LLMs, benchmarks their inference performance, conditionally evaluates their quality through Kibana Agent Builder evals, and reasons about improvement opportunities — all without human intervention beyond initial configuration.

**Core differentiator**: Unlike manual benchmark pipelines that deploy models with generic vLLM settings, this service parses each model's HuggingFace card to extract optimal deployment parameters before benchmarking, ensuring results reflect the model's true performance potential.

### Product Type
Standalone TypeScript service (daemon) that produces data consumed by Kibana dashboards.

### Target Scale
Single internal team (~5-10 engineers) choosing OSS LLMs for GPU deployment.

## 2. Vision

**The one-sentence rule**: The service automatically discovers promising open-source LLMs, reads each model's card to find the optimal vLLM deployment configuration, then benchmarks them through a three-stage pipeline (performance gate → quality eval → improvement reasoning), surfacing all results in Kibana dashboards with both raw metrics and actionable suggestions.

**Problem statement**: The team runs GPU infrastructure for serving open-source LLMs but choosing which models to deploy is manual, sporadic, and driven by social media rather than data. When models are benchmarked, they're often deployed with suboptimal settings (wrong quantization, missing tool-call parser, incorrect context length), producing misleading results. By the time a model is properly evaluated, newer ones have already shipped.

**What changes**: A standalone daemon runs 24/7, feeding a ranked, hardware-aware evaluation queue. Before each benchmark, it parses the model's HuggingFace card to extract the manufacturer's recommended deployment settings. Results appear in Kibana dashboards within minutes of completion, including suggestions for further tuning.

## 3. Goals

### Primary Goals
1. **Autonomous discovery**: System finds 1-2 promising new models per week without human input.
2. **Hardware-aware queueing**: Models that won't fit on available GPU memory are flagged before queueing.
3. **Optimal vLLM deployment**: Every benchmarked model is deployed with the correct flags from its HF card, not generic defaults.
4. **Three-stage pipeline**: Every queued model runs Stage 1 (performance). Promising models continue to Stage 2 (quality evals) and Stage 3 (reasoning).
5. **Zero-intervention operation**: Service runs for 7+ days without manual intervention.

### Secondary Goals
1. **Manual override**: Users can queue specific models via ES document write or CLI flag.
2. **Kibana-native visibility**: Results visible through standard Kibana dashboards without plugins.
3. **Historical comparison**: Track model performance over time across releases.

## 4. Non-Goals (Explicitly Out of Scope)

1. **No Kibana plugin or custom app**: Adoption through ES indices + dashboards only.
2. **No model variant recommendations beyond HF card**: Pipeline uses what the model card recommends. If the card is silent, it falls back to hardware-profile defaults. No independent quantization strategy engine.
3. **No non-NVIDIA GPU support**: vLLM's CUDA-first nature means NVIDIA-only.
4. **No model registry / artifact store**: Models downloaded directly from HuggingFace to benchmark VM on each run; no caching layer.
5. **No multi-region benchmarking**: Hardware profiles are per-cluster.
6. **No automated production deployment**: Pipeline evaluates only; promotion to production remains human decision.
7. **No offline/air-gapped support**: Discovery requires HF API; evals require Kibana repo.
8. **No LangGraph orchestration**: Replaced by explicit scheduler + ES-backed queue.

## 5. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Standalone TypeScript Daemon                      │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │  Discovery  │→ │  HF Card     │→ │   Queue      │               │
│  │  (HF API)   │  │  Parser      │  │   (ES docs)  │               │
│  └─────────────┘  └──────────────┘  └──────┬───────┘               │
│                                            │                        │
│  ┌─────────────────────────────────────────┘                        │
│  │  Stage 1: Read vllm_config from queue doc                         │
│  │          SSH → GPU VM → vllm serve <with extracted flags>         │
│  │          vllm bench serve                                         │
│  │  Stage 2: Clone Kibana main → Bootstrap → Run eval suites         │
│  │  Stage 3: LLM reasoning (cloud API) → Improvement suggestions     │
│  └──────────────────────────────────────────────────────────────────│
```
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Elasticsearch — Golden Cluster                   │
│              https://kbn-evals-serverless-ed035a...                  │
│                                                                      │
│  Queue + Results Indices:          Trace Indices (OTel native):      │
│  - benchmark-queue                 - .benchmark-traces-*              │
│  - benchmark-runs                  - .benchmark-metrics-*             │
│  - benchmark-evaluations           - .benchmark-logs-*                │
│  - benchmark-reasoning                                               │
│  - benchmark-models                                                  │
│  - benchmark-health-checks                                           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│              EDOT Collector (long-running Docker service)            │
│  - Receives OTLP from benchmark worker    - Forwards to golden ES    │
│  - Health check: /healthz endpoint      - Port: non-blocking         │
│  - 100% sampling, no tail-based dropping                             │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Kibana (Dashboards — golden cluster)                    │
│  - Pipeline Overview        - Performance Comparison                 │
│  - Quality Deep-Dive        - Improvement Suggestions                │
│  - vLLM Config Audit        - Trace Explorer (raw OTel)              │
│  - Evaluator Idea Discovery (raw trace pattern mining)               │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Components

**Discovery Service**: Polls HuggingFace API every 6 hours for new models matching filters (context window ≥128k, open-source license, text-generation pipeline). Ranks by download velocity, recency, and architecture novelty.

**HF Card Parser** (NEW): Before queueing, fetches and parses the model's README, `config.json`, and `generation_config.json` to extract:
- Context length (`max_position_embeddings`)
- Recommended quantization (`quantization_config`, or README mentions of AWQ/GPTQ/FP8)
- Tool-call parser requirements (README mentions of function calling, tool use)
- Special vLLM flags (`--enable-reasoning`, `--reasoning-parser`, `--tool-call-parser`)
- Architecture type (dense vs MoE, attention pattern)

**Hardware-Fit Check**: Estimates GPU memory from parsed config (parameters × precision + KV cache) vs available profiles. Models that don't fit are queued with `status: rejected-hardware` for visibility but skipped for benchmarking.

**Queue Manager**: ES-backed polling loop. One worker thread processes one model at a time. Queue is ordered by priority score (discovery score × hardware fit). Manual queue entries get highest priority.

**Stage 1 — Performance Worker**: SSH to GPU VM, run `vllm serve` with flags from `vllm_config` in queue document, then `vllm bench serve` at multiple concurrency levels. Parse ITL/TTFT/throughput. Write results to `benchmark-runs`.

**Stage 2 — Quality Worker** (conditional): If Stage 1 results pass thresholds, clone Kibana main (pinned commit), bootstrap dependencies, run user-selected eval suites against the vLLM endpoint. Write per-suite scores to `benchmark-evaluations`.

**Stage 3 — Reasoning Worker**: Before calling the reasoning LLM, executes ES|QL queries over raw OTel traces (`.benchmark-traces-*`) to extract failure patterns, latency distributions by operation, and tool-call parsing errors. Constructs structured prompt with Stage 1 + Stage 2 results + vLLM config + trace pattern summary. Calls cloud LLM API for improvement suggestions. Stores in `benchmark-reasoning`.

## 6. Functional Requirements

### 6.1 Discovery (FR-001 – FR-005)
| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-001 | Autonomously discover promising OSS models from HuggingFace | Must-have | Modified (exists but orphaned) |
| FR-002 | Filter by context window (min 128k), license, architecture | Must-have | Preserved |
| FR-003 | Hardware-fit check: estimate GPU memory vs available profiles | Must-have | New |
| FR-004 | User can manually queue a model via ES document or CLI flag | Must-have | New |
| FR-005 | Manual queue entries evaluated after current in-flight eval | Must-have | New |

### 6.2 vLLM Configuration Discovery (FR-011-BIS – FR-011-QUINQUIES)
| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-011-BIS | Before Stage 1, fetch and parse HF model card README + config.json + generation_config.json to extract: context length, quantization, tool-call parser, vLLM flags | Must-have | New |
| FR-011-TER | Store extracted config in queue document `vllm_config` field | Must-have | New |
| FR-011-QUATER | Use model card recommendation as default; fallback to hardware-profile default (BF16 for ≥80GB, INT8 for ≤24GB) if card is silent | Must-have | New |
| FR-011-QUINQUIES | Stage 3 reasoning includes vLLM config as input; suggest flag changes if performance is poor | Must-have | New |

### 6.3 Benchmark Execution — Stage 1 (FR-006 – FR-008)
| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-006 | Deploy model via SSH using `vllm_config` flags, run `vllm bench serve` | Must-have | Preserved (modified to use parsed config) |
| FR-007 | Parse ITL, TTFT, throughput into structured result | Must-have | Preserved |
| FR-008 | Graceful failure: cancel/skip if deploy fails or OOM | Must-have | New |

### 6.4 Quality Evaluation — Stage 2 (FR-009 – FR-011)
| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-009 | If Stage 1 passes thresholds, clone Kibana main and run eval suites | Must-have | Modified (was stubbed, now conditional gate) |
| FR-010 | User-configurable eval suites (global default + per-model override) | Must-have | New |
| FR-011 | Write quality scores, per-suite breakdowns, trajectory traces | Must-have | New |

### 6.5 Reasoning — Stage 3 (FR-012 – FR-014)
| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-012 | LLM reasons about improvement suggestions from Stage 1+2 results | Must-have | New |
| FR-013 | Store suggestions: prompt changes, system prompt tweaks, temperature adjustments, quantization recommendations, vLLM flag changes | Must-have | New |
| FR-014 | **Trace-based reasoning**: Stage 3 executes ES|QL queries over raw OTel traces (`FROM .benchmark-traces-*`) to understand why eval cases failed and mine patterns for new evaluator ideas. Results fed into reasoning LLM prompt. | Must-have | New |

### 6.6 Trace Infrastructure (FR-015 – FR-018)
| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-015 | EDOT Collector health check (`/healthz`) before every run. Skip run if collector unhealthy. | Must-have | New |
| FR-016 | Eval suite traces sent via OTLP to EDOT Collector → golden ES cluster as native OTel (PascalCase: `TraceId`, `SpanId`, `Attributes`, etc.) | Must-have | New |
| FR-017 | 100% trace sampling — zero tail-based dropping or probabilistic sampling | Must-have | New |
| FR-018 | ILM policy for `.benchmark-traces-*` and `.benchmark-metrics-*` (default 30-day retention, configurable) | Should-have | New |

### 6.7 Results & Visualization (FR-019 – FR-021)
| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-019 | All stage results written to ES, visible in Kibana dashboards | Must-have | Preserved |
| FR-020 | Dashboard shows queue status, current stage, per-run progress, vLLM config audit | Must-have | New |
| FR-021 | Queue model by writing ES document (API call or direct index write) | Must-have | New |

### 6.7 Configuration Requirements

- **Hardware profiles**: Defined in config file (YAML). Each profile has: name, GPU count, GPU memory per device, CUDA compute capability.
- **Stage 1 thresholds**: Configurable per profile. E.g., `max_p50_itl_ms: 200`, `min_throughput_tps: 50`.
- **Stage 2 eval suites**: Global list in config. Per-model override via queue document field `eval_suites: [...]`.
- **Kibana repo**: Config specifies `kibana.commit` (SHA or tag) and `kibana.repo_url`.
- **Stage 3 LLM**: Config specifies `reasoning.provider` (openai/anthropic), `reasoning.model`, `reasoning.api_key_env`.
- **HF API**: Config specifies `huggingface.token_env` for authenticated API access (higher rate limits).

## 7. User Stories

### US-01: Autonomous discovery → full pipeline with optimal config
```
Given the benchmark service is running with discovery enabled
  and hardware profile "A100-80GBx4" is configured
When HuggingFace publishes a new 70B model with 128k context window
  and Apache 2.0 license
Then the model is automatically queued
  AND its HF card is parsed to extract vLLM flags (quantization=awq,
  tool-call-parser=hermes, max-model-len=131072)
  and Stage 1 runs with those flags
  and continues to Stage 2 if ITL p50 < 200ms
  and runs Stage 3 reasoning:
    - Queries raw OTel traces via ES|QL to understand where evals failed
    - Includes trace patterns alongside metrics in the reasoning prompt
  and all results appear in Kibana dashboards within 2 hours.
```

### US-02: Manual queueing with custom vLLM config
```
Given a teammate wants to benchmark a specific model configuration
When they run: benchmarker queue --model "Qwen/Qwen3-235B-A22B" \
  --vllm-flags "--tensor-parallel-size=4 --quantization=fp8" \
  --suites tool_calls,latency
Then the model is added to queue with those flags
  and evaluated after the current in-flight model finishes
  and results appear in dashboards when complete.
```

### US-03: Performance gate skips expensive eval
```
Given a model is queued and Stage 1 runs
When the model's ITL exceeds 500ms at batch size 8
Then Stage 2 is SKIPPED
  and Stage 3 provides reasoning: "ITL too high; try AWQ quantization
  or reduce max-model-len. Current config used BF16 on 80GB GPUs."
  and the run is marked "stage1_pass: false" in dashboards.
```

### US-04: Dashboard three-stage view with vLLM audit
```
Given the service has evaluated 5 models this week
When a team member opens Kibana
Then they see:
  - Table: Model | Stage 1 ITL p50 | Stage 2 tool_calls score | Stage 3 top suggestion
  - vLLM Config Audit: which flags were used for each model
  - Queue status: 2 pending, 1 in-progress (Stage 2, vLLM flags visible)
  - Trend chart: ITL over time for models that passed Stage 1
```

## 8. Data Model

### Index: benchmark-queue
```json
{
  "model_id": "Qwen/Qwen3-70B",
  "status": "pending | in-progress | completed | failed",
  "priority": 100,
  "queued_at": "2026-06-14T10:00:00Z",
  "started_at": "2026-06-14T10:05:00Z",
  "completed_at": null,
  "source": "discovery | manual",
  "requested_by": null,
  "eval_suites": ["tool_calls", "latency"],
  "hardware_profile": "A100-80GBx4",
  "vllm_config": {
    "context_length": 131072,
    "quantization": "awq",
    "tool_call_parser": "hermes",
    "flags": [
      "--max-model-len=131072",
      "--quantization=awq",
      "--tool-call-parser=hermes"
    ],
    "source": "model_card"
  },
  "error": null
}
```

### Index: benchmark-runs (Stage 1)
```json
{
  "run_id": "uuid",
  "model_id": "Qwen/Qwen3-70B",
  "hardware_profile": "A100-80GBx4",
  "stage": 1,
  "status": "passed | failed | error",
  "vllm_config_used": {
    "context_length": 131072,
    "quantization": "awq",
    "flags": ["--max-model-len=131072", "--quantization=awq"]
  },
  "metrics": {
    "itl": {"p50": 45, "p99": 120, "mean": 52},
    "ttft": {"p50": 120, "p99": 300, "mean": 140},
    "throughput_tps": 85.3,
    "concurrency_levels": [1, 2, 4, 8, 16]
  },
  "thresholds_applied": {
    "max_p50_itl_ms": 200,
    "min_throughput_tps": 50
  },
  "gate_passed": true,
  "started_at": "2026-06-14T10:05:00Z",
  "completed_at": "2026-06-14T10:20:00Z"
}
```

### Index: benchmark-evaluations (Stage 2)
```json
{
  "run_id": "uuid",
  "model_id": "Qwen/Qwen3-70B",
  "stage": 2,
  "kibana_commit": "abc123",
  "suites_run": ["tool_calls", "latency"],
  "suite_results": {
    "tool_calls": {"score": 0.87, "pass_rate": 0.92, "duration_sec": 180},
    "latency": {"score": 0.75, "pass_rate": 0.80, "duration_sec": 120}
  },
  "trajectory_traces_index": ".benchmark-trajectories-2026.06.14",
  "started_at": "2026-06-14T10:21:00Z",
  "completed_at": "2026-06-14T10:35:00Z"
}
```

### Index: benchmark-reasoning (Stage 3)
```json
{
  "run_id": "uuid",
  "model_id": "Qwen/Qwen3-70B",
  "stage": 3,
  "stage2_ran": true,
  "vllm_config_considered": {
    "quantization": "awq",
    "context_length": 131072
  },
  "suggestions": [
    {
      "category": "vllm_config",
      "current": "--quantization=awq --max-model-len=131072",
      "suggested": "Switch to --quantization=fp8 for 15% better throughput",
      "expected_impact": "+12 tps, ITL p50 drops to 38ms",
      "confidence": "high"
    },
    {
      "category": "prompt_template",
      "current": "Default system prompt",
      "suggested": "Add explicit tool-call formatting instructions",
      "expected_impact": "+5% tool_calls pass_rate",
      "confidence": "high"
    }
  ],
  "raw_llm_output": "...",
  "llm_model": "claude-sonnet-4-6",
  "started_at": "2026-06-14T10:36:00Z",
  "completed_at": "2026-06-14T10:37:00Z"
}
```

## 9. API / Interfaces

### Queue Model (Manual)
```bash
# CLI
benchmarker queue --model "Qwen/Qwen3-70B" --profile "A100-80GBx4" --suites tool_calls,latency

# With explicit vLLM flags (overrides HF card parsing)
benchmarker queue --model "Qwen/Qwen3-70B" \
  --vllm-flags "--tensor-parallel-size=4 --quantization=fp8 --max-model-len=65536" \
  --profile "A100-80GBx4" --suites tool_calls

# Direct ES write equivalent
POST benchmark-queue/_doc
{
  "model_id": "Qwen/Qwen3-70B",
  "status": "pending",
  "priority": 999,
  "source": "manual",
  "requested_by": "patryk",
  "eval_suites": ["tool_calls", "latency"],
  "hardware_profile": "A100-80GBx4",
  "vllm_config": {
    "flags": ["--tensor-parallel-size=4", "--quantization=fp8"],
    "source": "manual_override"
  }
}
```

### Service Start
```bash
benchmarker daemon --config /etc/benchmarker/config.yaml
```

### Config File (YAML)
```yaml
elasticsearch:
  url: "http://localhost:9200"           # PRIMARY — local queue + results + traces
  api_key: "${ES_API_KEY}"

golden_cluster:                            # OPTIONAL secondary destination
  url: "https://kbn-evals-serverless-ed035a.kb.us-central1.gcp.elastic.cloud"
  api_key: "${GOLDEN_ES_API_KEY}"
  forward_to_golden: false                 # Toggle when ready to share

edot_collector:
  otlp_endpoint: "http://localhost:4318"   # Local EDOT receiver
  health_url: "http://localhost:8080/healthz"
  container_id: "3084721cdd0466f68cd1d3df496a5c11bd68ef0919ddca1739d30255edc091a1"
  sampling_rate: 1.0                       # 1.0 = 100%, no dropping
  trace_retention_days: 30                 # ILM policy for trace indices
  # Also forward to golden if configured:
  golden_otlp_endpoint: "https://kbn-evals-serverless-ed035a.kb.us-central1.gcp.elastic.cloud:443"

gpu_vms:
  - name: "benchmark-a100"
    host: "gpu-benchmark.internal"
    ssh_key: "${SSH_KEY_PATH}"
    hardware_profile: "A100-80GB"

stage2_thresholds:
  max_itl_p50_ms: 200
  min_throughput_tps: 50

hardware_profiles:
  - name: "A100-80GBx4"
    gpu_count: 4
    gpu_memory_gb: 80
    cuda_compute: "8.0"
    default_quantization: "bf16"

stage1:
  thresholds:
    max_p50_itl_ms: 200
    min_throughput_tps: 50
  concurrency_levels: [1, 2, 4, 8, 16]

stage2:
  kibana_repo_url: "https://github.com/elastic/kibana.git"
  kibana_commit: "main"
  default_eval_suites: ["tool_calls", "latency", "skill_invocation"]
  bootstrap_timeout_min: 30

stage3:
  reasoning_provider: "anthropic"
  reasoning_model: "claude-sonnet-4-6"
  api_key_env: "ANTHROPIC_API_KEY"

huggingface:
  token_env: "HF_TOKEN"
  discovery_interval_hours: 6
  filters:
    min_context_window: 128000
    licenses: ["apache-2.0", "mit", "llama3.1"]
    pipeline_tags: ["text-generation"]
    min_downloads_7d: 100

ssh:
  host: "gpu-vm.internal"
  user: "benchmark"
  key_path: "${SSH_KEY_PATH}"
```

## 10. Error Handling & Reliability

| Scenario | Behavior |
|---|---|
| HF API rate limited | Backoff with jitter (1s, 2s, 4s, 8s, 16s). Log warning. Resume on next discovery cycle. |
| HF card missing / empty README | Log warning. Use hardware-profile default for vLLM config. Proceed with benchmark. |
| HF card parsing fails (malformed JSON) | Log specific error. Use hardware-profile default. Proceed with benchmark. |
| SSH connection lost | Mark run as "error", log SSH error, move to next queue item. Do NOT retry automatically. |
| vLLM OOM (even with parsed config) | Mark as "failed - OOM", log GPU memory estimate vs actual + vLLM config used. Stage 3 suggests quantization or smaller batch. |
| Model download fails | Retry 3× with exponential backoff. If persistent, mark as "failed - download". |
| vLLM flags from card cause startup failure | Log exact flags that failed. Try fallback config (hardware-profile default). If still failing, mark "failed - deploy". |
| Kibana bootstrap fails | Mark Stage 2 as "failed - bootstrap", log output. Stage 3 reasons about bootstrap failure. |
| Eval suite hangs | Timeout after configured `suite_timeout_min`. Kill process. Mark suite as "timeout". |
| Stage 3 LLM API error | Retry 2×. If persistent, store placeholder: "Reasoning unavailable due to API error." |
| ES unavailable | Buffer results in memory + local file. Retry ES write every 30s. Backpressure if buffer > 100MB. |
| **EDOT Collector unhealthy** | Health check fails (`/healthz` timeout or non-200). Log error, skip current run. Re-check on next scheduler tick. Do NOT start vLLM if collector down. |
| **Golden ES cluster unreachable** | If trace cluster unavailable but local ES is up: run benchmark, but warn that traces won't be stored. Write local OTLP fallback file for later replay. |

## 11. Security & Compliance

- **SSH credentials**: Stored in environment variables or secure config file (not in repo). Service reads from `${SSH_KEY_PATH}` env var.
- **ES API key**: Scoped to benchmark indices only (`benchmark-*`). No cluster-admin privileges.
- **Golden cluster API key**: Separate key stored in `GOLDEN_ES_API_KEY`. Scoped to trace metrics indices only.
- **Kibana repo**: Public GitHub repo, no auth needed for clone.
- **LLM API key**: Stored in environment variable referenced by config (`api_key_env`).
- **HF token**: Stored in environment variable (`HF_TOKEN`) for authenticated API access (higher rate limits).
- **No PII**: Pipeline handles only model IDs and benchmark metrics; no user data.

## 12. Shared Scripts & Health Checks

All infrastructure scripts are shared and reusable across environments (dev/staging/prod).

### `scripts/health-check.sh` (shared)
```bash
#!/usr/bin/env bash
# Shared health check — used by systemd service, Docker healthcheck, and CI
# Checks: EDOT collector, Golden ES cluster, GPU VM SSH, vLLM endpoint
set -euo pipefail

EDOT_URL="${EDOT_HEALTH_URL:-http://localhost:8080/healthz}"
GOLDEN_ES="${GOLDEN_ES_URL:-https://kbn-evals-serverless-ed035a.kb.us-central1.gcp.elastic.cloud}"
SSH_HOST="${GPU_VM_SSH_HOST:-gpu-vm.internal}"

# Check EDOT Collector
curl -sf "$EDOT_URL" > /dev/null || { echo "EDOT unhealthy"; exit 1; }

# Check Golden ES
curl -sf -H "Authorization: ApiKey ${GOLDEN_ES_API_KEY}" \
  "$GOLDEN_ES/_cluster/health" > /dev/null || { echo "Golden ES unreachable"; exit 1; }

# Check GPU VM SSH
ssh -o ConnectTimeout=5 "$SSH_HOST" true || { echo "GPU VM unreachable"; exit 1; }

echo "All checks passed"
```

### `scripts/start-edot.sh` (shared)
```bash
#!/usr/bin/env bash
# Reproducible EDOT collector startup — Docker Compose or systemd
set -euo pipefail

EDOT_IMAGE="docker.elastic.co/observability/elastic-otel-collector:latest"
CONTAINER_ID="3084721cdd0466f68cd1d3df496a5c11bd68ef0919ddca1739d30255edc091a1"

# If container exists and running, do nothing
if docker ps --filter "id=$CONTAINER_ID" --format '{{.Names}}' | grep -q .; then
  echo "EDOT already running"
  exit 0
fi

# If container exists but stopped, start it
if docker ps -a --filter "id=$CONTAINER_ID" --format '{{.Names}}' | grep -q .; then
  docker start "$CONTAINER_ID"
  echo "EDOT restarted"
  exit 0
fi

# Fresh start
docker run -d \
  --name elastic-otel-collector \
  -p 4318:4318 \
  -p 8080:8080 \
  -e "OTEL_EXPORTER_OTLP_ENDPOINT=${GOLDEN_ES_URL}" \
  -e "OTEL_EXPORTER_OTLP_HEADERS=Authorization=ApiKey ${GOLDEN_ES_API_KEY}" \
  "$EDOT_IMAGE"
echo "EDOT started fresh"
```

### `scripts/setup-ilm.sh` (shared)
```bash
#!/usr/bin/env bash
# Create ILM policy for trace indices
set -euo pipefail

curl -X PUT "${GOLDEN_ES_URL}/_ilm/policy/benchmark-traces" \
  -H "Authorization: ApiKey ${GOLDEN_ES_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "policy": {
      "phases": {
        "hot": { "min_age": "0ms", "actions": { "rollover": { "max_age": "1d", "max_size": "50gb" } } },
        "warm": { "min_age": "7d", "actions": { "shrink": { "number_of_shards": 1 } } },
        "delete": { "min_age": "30d", "actions": { "delete": {} } }
      }
    }
  }'
```

## 13. Milestones & Timeline

### Week 1: Foundation — Pipeline Skeleton + HF Card Parser
- Remove LangGraph, replace with explicit scheduler + ES queue loop
- Reconnect discovery service (FR-001, FR-002, FR-003)
- **HF Card Parser**: Fetch README + config.json + generation_config.json, extract vLLM flags
- Stage 1: End-to-end `vllm bench serve` with parsed config → ES write
- Basic queue management (enqueue, dequeue, status tracking)
- **Deliverable**: Service runs autonomously, benchmarks one model with correct HF card config, stores Stage 1 results.

### Week 2: Stage 2 — Quality Eval Integration
- Kibana repo clone + bootstrap automation
- Eval suite runner integration (run selected suites against vLLM endpoint)
- Stage 1 → Stage 2 conditional gate
- Per-suite result storage
- **Deliverable**: Full two-stage pipeline (performance + quality) for manually queued models.

### Week 3: Stage 3 + Dashboards
- LLM reasoning integration (prompt engineering for improvement suggestions)
- Include vLLM config in reasoning prompt
- Stage 3 result storage and linking
- Kibana dashboards (importable saved objects) including vLLM config audit panel
- Configuration validation and error handling hardening
- **Deliverable**: Three-stage pipeline complete, results visible in Kibana.

### Week 4: Autonomy + Hardening
- Autonomous discovery re-enablement (end-to-end without manual queueing)
- Hardware profile validation and rejection
- Service health monitoring and alerting
- Documentation and runbook
- **Deliverable**: Service runs 7+ days autonomously. Team can add models manually and view all results in Kibana.

## 13. Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| Node.js | ≥ 20 | Runtime |
| TypeScript | ≥ 5.5 | Language |
| Elasticsearch | ≥ 8.12 | Queue + results store |
| Kibana | ≥ 8.12 | Dashboards |
| vLLM | ≥ 0.5.0 | Model serving + benchmarking |
| Kibana repo (main) | Pinned commit | Stage 2 eval infrastructure |
| Python | ≥ 3.11 | Kibana bootstrap + eval suites |
| Cloud LLM API | — | Stage 3 reasoning |
| EDOT Collector | latest | OTLP receiver → golden ES cluster |
| Docker | ≥ 24.0 | Long-running EDOT Collector container |

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| HF model cards are inconsistent / sparse | Parser has fallbacks for every field. Hardware-profile defaults always available. Log when card is silent. |
| Kibana main is unstable / broken at pinned commit | Pin to a known-good tag (e.g., `8.15.0`), not `main`. Update tag monthly. |
| GPU VM unavailable / SSH fails | Health check on startup. Alert if VM unreachable. Queue pauses until VM recovers. |
| HuggingFace API changes | Use `@huggingface/hub` client library, not raw REST. Monitor for deprecation notices. |
| Eval suites take too long | Configurable suite timeout. Parallel suite execution if Kibana eval supports it. |
| Cloud LLM API costs spike | Reasoning is 1 call per evaluation. Track token usage. Option to disable Stage 3 per-model. |
| **ES disk fills with 100% trace sampling** | ILM policy on trace indices (default 30-day retention). Daily rollover (`max_size: 50gb`). Monitor cluster alerts. |
| **EDOT Collector crashes / OOM** | Docker restart policy `always`. Health check API. Alert on container exit. |
| **Golden ES cluster rate limiting** | Batch trace writes. Use persistent queue (local file fallback) if cluster backpressures. |

## 15. Metrics & Success Criteria

| Metric | Target | Measurement |
|---|---|---|
| Autonomous discovery rate | 1-2 models/week | Count of models auto-added to queue |
| HF card parse success rate | > 90% | Models with successfully parsed vLLM config |
| End-to-end pipeline success rate | > 80% | Runs completing all stages without error |
| Stage 1 → Stage 2 promotion rate | 30-50% | Models passing performance gate |
| Stage 2 → Stage 3 completion rate | > 95% | Models completing reasoning after quality eval |
| Dashboard freshness | < 5 min lag | Time from run completion to dashboard update |
| Service uptime | > 99% | Daemon process availability |
| False-negative rate (good model marked bad) | < 5% | Good models that failed due to wrong vLLM config |
