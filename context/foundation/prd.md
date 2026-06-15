# Product Requirements Document: Elastic LLM Benchmarker

## 1. Overview

The Elastic LLM Benchmarker is a **model qualification gate** for Elastic
Agent Builder. It evaluates open-source LLMs against a canonical set of
performance and quality criteria and produces a structured **recommendation
report** that Elastic product teams use to decide which models to officially
support in the Elastic Inference Service (EIS).

**Phase 1 (now):** Internal-only tool used by Elastic engineers and PMs.
**Phase 2 (later):** Extensible to external users who want self-hosting guidance.

The pipeline has three stages:
1. **Stage 1 — Performance Gate:** `vllm bench serve` measures ITL/TTFT/throughput.
   If results are NOT promising → stop, produce a rejection recommendation.
2. **Stage 2 — Quality Eval (Kibana):** ONLY if Stage 1 passes, run specific
   Agent Builder eval suites (tool_calls, skill_invocation, etc.) against the
   vLLM endpoint.
3. **Stage 3 — Reasoning:** LLM reasons over Stage 1+2 results + raw OTel traces
   to produce improvement suggestions and a final verdict.

**Primary output:** A `recommendation-report` document with a `verdict` field
(`support` / `investigate` / `reject`) that a PM can read and act on in < 5 minutes.

**Secondary output:** Dashboards in Kibana for historical trend analysis and
operational observability.

---

## 2. Current State

A ~33K-line TypeScript codebase exists with: vLLM engine, HF model discovery,
ES store, queue API, EDOT trace collector, and golden cluster forwarding.
The architecture is sound but execution gaps exist:
- Model discovery is orphaned (not wired to the pipeline).
- LangGraph config points to a 212-char stub.
- Queue consumer is a separate binary requiring manual startup.
- No recommendation report artifact exists; dashboards are the only output.
- Hardware profile (`nvidia-l4` / 1 GPU) does not match the target VM (2×A100-80GB).

**This PRD reframes the product around the recommendation report and redirects
M1 engineering effort to close the execution gaps.**

---

## 3. Vision

> An autonomous qualification pipeline that continuously proposes promising
> open-source LLMs for Elastic Agent Builder support, validates them through
> empirical evals, and produces a trusted recommendation report — so Elastic
> PMs can make model-support decisions in minutes, not days.

---

## 4. Goals

1. **Phase 1: Accelerate Agent Builder model-support decisions.**
   Reduce the time from "new model on HuggingFace" to "support decision"
   from days/weeks to hours.

2. **Phase 1: Prevent bad models from reaching supported status.**
   The performance gate must catch slow or low-quality models before expensive
   eval suites are run.

3. **Phase 1: Provide empirical evidence for every support decision.**
   Every "support" verdict is backed by passing eval scores, performance
   metrics, and trace-based reasoning.

4. **Phase 2: Enable external self-hosting guidance.**
   The same pipeline must be runnable by external users to answer "what works
   on my hardware?" with no Elastic-internal dependencies.

5. **Maintainability.** The service must be operable by 1-2 people with clear
   runbooks, health checks, and ES-backed observability.

---

## 5. Non-Goals

1. **Phase 1 is NOT a public service.** It runs on Elastic-internal infra
   (EIS, private HF org, golden ES cluster). Phase 2 will abstract this away.

2. **Does NOT define the eval bar.** The Agent Builder team defines which eval
   suites and thresholds constitute "supported." The benchmarker measures
   against the bar; it does not set it.

3. **Does NOT auto-promote models.** The system proposes; humans decide.
   A recommendation report is input to a human decision, not a trigger for
   automated EIS registration.

4. **No Kibana plugin or custom app development.** Kibana is used for
   dashboards (visualization) and eval suite execution (dependency). No
   code runs inside Kibana.

5. **No model fine-tuning, RLHF, or training infrastructure.** This is an
   evaluation and recommendation tool, not a training platform.

6. **No Ollama or other inference engines.** vLLM-only for reproducibility.

---

## 6. Functional Requirements

### 6.1 Recommendation Report (FR-REC-001 – FR-REC-006) — NEW

| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-REC-001 | Pipeline MUST produce a structured `recommendation-report` document after every completed evaluation (all stages or early-exit after Stage 1) | Must-have | New |
| FR-REC-002 | Report MUST contain `verdict` field with values: `support`, `investigate`, `reject` | Must-have | New |
| FR-REC-003 | `support` verdict is ONLY emitted when Stage 1 passes AND all configured Stage 2 eval suites pass their thresholds | Must-have | New |
| FR-REC-004 | `investigate` verdict is emitted when Stage 1 passes but at least one eval suite fails OR results are ambiguous (near-threshold) | Must-have | New |
| FR-REC-005 | `reject` verdict is emitted when Stage 1 fails OR when model is fundamentally incompatible (e.g., no tool-call support detected) | Must-have | New |
| FR-REC-006 | Reports are immutable and versioned. Each new evaluation creates a new document. Latest report per model is the current recommendation. | Must-have | New |

### 6.2 Discovery & Queueing (FR-001 – FR-006) — REFRAMED

| ID | Requirement | Status | Change |
|---|---|---|---|
| FR-001 | HuggingFace API integration to discover new models | Preserved | Unchanged |
| FR-002 | Parse HF model cards (README, config.json) to extract vLLM flags | Preserved | Unchanged |
| FR-003 | Extract: context length, quantization, tool-call parser type from model card | Preserved | Unchanged |
| FR-004 | Automatically add qualifying models to queue based on filters | **Deferred to M2** | Discovery comes AFTER recommendation artifact is proven |
| FR-005 | Manual queueing via CLI (`benchmarker enqueue --model ...`) | Preserved | MVP path |
| FR-006 | Queue stored in ES; polled by scheduler; model is dequeued and benchmarked once GPU is free | Preserved | Unchanged |

### 6.3 Stage 1 — Performance Gate (FR-007 – FR-009)

| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-007 | Run `vllm bench serve` on GPU VM (SSH) | Must-have | Unchanged |
| FR-008 | Measure ITL, TTFT, throughput at configured concurrency levels | Must-have | Unchanged |
| FR-009 | Gate: `max_p50_itl_ms` and `min_throughput_tps` thresholds from hardware profile. If gate fails → emit `reject` recommendation, skip Stage 2. | Must-have | Unchanged |

### 6.4 Stage 2 — Quality Eval (FR-010 – FR-011)

| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-010 | Run eval suites (tool_calls, skill_invocation, latency, etc.) against vLLM endpoint | Must-have | Unchanged |
| FR-010a | Eval suite list and pass thresholds are configurable per model or globally. The benchmarker does not define thresholds; it reads them from config. | Must-have | Clarification |
| FR-011 | Eval traces sent via OTLP → EDOT Collector → golden ES cluster (PascalCase OTel fields: `TraceId`, `SpanId`, `Attributes`, etc.) | Must-have | Unchanged |

### 6.5 Reasoning — Stage 3 (FR-012 – FR-014)

| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-012 | LLM reasons about improvement suggestions from Stage 1+2 results | Must-have | Unchanged |
| FR-013 | Store suggestions: prompt changes, system prompt tweaks, temperature adjustments, quantization recommendations, vLLM flag changes | Must-have | Unchanged |
| FR-014 | **Trace-based reasoning**: Stage 3 executes ES|QL queries over raw OTel traces (`FROM .benchmark-traces-*`) to understand why eval cases failed and mine patterns for new evaluator ideas. Results fed into reasoning LLM prompt. | Must-have | Unchanged |

### 6.6 Trace Infrastructure (FR-015 – FR-018)

| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-015 | EDOT Collector health check (`/healthz`) before every run. Skip run if collector unhealthy. | Must-have | Unchanged |
| FR-016 | Eval suite traces sent via OTLP to EDOT Collector → golden ES cluster as native OTel | Must-have | Unchanged |
| FR-017 | 100% trace sampling — zero dropping | Must-have | Unchanged |
| FR-018 | ILM policy for `.benchmark-traces-*` and `.benchmark-metrics-*` (default 30-day retention, configurable) | Should-have | Unchanged |

### 6.7 Results & Visualization (FR-019 – FR-022)

| ID | Requirement | Priority | Change |
|---|---|---|---|
| FR-019 | All stage results written to ES, visible in Kibana dashboards | Must-have | Preserved |
| FR-020 | Dashboard shows queue status, current stage, per-run progress, vLLM config audit | Must-have | Unchanged |
| FR-021 | Queue model via REST API `POST /api/v1/evaluate` or direct ES index write | Must-have | Preserved |
| FR-022 | **Recommendation report index queryable and linkable.** A PM can open a saved-object link to a specific model's latest recommendation. | Must-have | New |

---

## 7. User Stories

### US-01: Autonomous proposal → recommendation report (M2)
```
Given the benchmark service is running with discovery enabled
  and hardware profile "A100-80GBx2" is configured
When HuggingFace publishes a new 70B model with 128k context window
  and Apache 2.0 license
Then the model is automatically queued
  AND its HF card is parsed to extract vLLM flags
  and Stage 1 runs with those flags
  and continues to Stage 2 if ITL p50 < 200ms
  and runs Stage 3 reasoning
    - Queries raw OTel traces via ES|QL to understand where evals failed
    - Includes trace patterns alongside metrics in the reasoning prompt
  and a recommendation report is written to ES with verdict:
    support (if all evals pass), investigate (if mixed), or reject (if failed)
  AND a notification (Slack) is sent with a link to the report.
```

### US-02: Manual queueing with custom vLLM config
```
Given a teammate wants to benchmark a specific model configuration
When they run: benchmarker enqueue --model "Qwen/Qwen3-235B-A22B" \
  --vllm-flags "--tensor-parallel-size=4 --quantization=fp8" \
  --suites tool_calls,latency
Then the model is added to queue with those flags
  and evaluated after the current in-flight model finishes
  and a recommendation report is produced when complete.
```

### US-03: Performance gate skips expensive eval
```
Given a model is queued and Stage 1 runs
When the model's ITL exceeds 500ms at batch size 8
Then Stage 2 is SKIPPED
  and a reject recommendation is produced:
    "Verdict: reject. Reason: ITL too high. Suggested action: try AWQ
    quantization or reduce max-model-len."
```

### US-04: PM reviews recommendation and makes decision
```
Given the service has evaluated 5 models this week
When the Agent Builder PM opens Kibana
Then they see:
  - A "Pending Decisions" panel: models with verdict "support" awaiting PM review
  - Clicking a model opens the full recommendation report
  - The report shows: verdict, passing evals, blocking issues, vLLM config used,
    and a "Propose for EIS support" CTA (manual action)
```

### US-05: External user self-hosting guidance (Phase 2)
```
Given an external user with 2×A100-80GB GPUs
When they run: benchmarker recommend --hardware-profile "A100-80GBx2" \
  --task "tool-calling" --top 3
Then they receive a ranked list of models with:
  - Expected ITL/TTFT on their hardware
  - vLLM config flags to use
  - Confidence score based on eval pass rates
```

---

## 8. Data Model

### Index: recommendation-report (NEW)
```json
{
  "report_id": "uuid",
  "model_id": "Qwen/Qwen2.5-72B-Instruct",
  "model_name": "Qwen2.5-72B-Instruct",
  "verdict": "support | investigate | reject",
  "confidence": "high | medium | low",
  "hardware_profile": "A100-80GBx2",
  "stage1_passed": true,
  "stage2_passed": true,
  "passing_evals": [
    {"suite": "tool_calls", "score": 0.94, "threshold": 0.85, "passed": true},
    {"suite": "skill_invocation", "score": 0.91, "threshold": 0.80, "passed": true}
  ],
  "blocking_issues": [
    {"severity": "warning", "category": "throughput", "message": "TTFT p99 is 310ms, slightly above target of 300ms"}
  ],
  "vllm_config_used": {
    "context_length": 131072,
    "quantization": "awq",
    "tool_call_parser": "hermes",
    "flags": ["--max-model-len=131072", "--quantization=awq", "--tool-call-parser=hermes"],
    "source": "model_card | manual_override | hardware_profile_default"
  },
  "suggestions": [
    {
      "category": "vllm_config",
      "current": "--quantization=awq",
      "suggested": "Switch to --quantization=fp8 for 15% better throughput",
      "expected_impact": "+12 tps, ITL p50 drops to 38ms",
      "confidence": "high"
    }
  ],
  "stage1_metrics": {
    "itl": {"p50": 45, "p99": 120, "mean": 52},
    "ttft": {"p50": 120, "p99": 300, "mean": 140},
    "throughput_tps": 85.3
  },
  "stage2_results": {
    "suites_run": ["tool_calls", "skill_invocation"],
    "suite_results": {
      "tool_calls": {"score": 0.94, "pass_rate": 0.92, "duration_sec": 180},
      "skill_invocation": {"score": 0.91, "pass_rate": 0.89, "duration_sec": 200}
    }
  },
  "reasoning_summary": "Model passes all gates with strong tool-calling performance...",
  "raw_llm_output": "...",
  "llm_model": "claude-sonnet-4-6",
  "trace_run_id": "uuid",
  "run_id": "uuid",
  "version": 1,
  "evaluated_at": "2026-06-15T10:00:00Z",
  "evaluated_by": "benchmarker-v2.1.0",
  "source": "discovery | manual",
  "requested_by": "patryk@elastic.co"
}
```

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
  "hardware_profile": "A100-80GBx2",
  "vllm_config": {
    "context_length": 131072,
    "quantization": "awq",
    "tool_call_parser": "hermes",
    "flags": ["--max-model-len=131072", "--quantization=awq", "--tool-call-parser=hermes"],
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
  "hardware_profile": "A100-80GBx2",
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
    }
  ],
  "raw_llm_output": "...",
  "llm_model": "claude-sonnet-4-6",
  "started_at": "2026-06-14T10:36:00Z",
  "completed_at": "2026-06-14T10:37:00Z"
}
```

### Index: benchmarker-errors (DLQ)
```json
{
  "error_id": "uuid",
  "component": "golden_forwarder | discovery | scheduler | ssh | vllm | api",
  "reason": "rate_limit | timeout | connection_failed | es_unavailable | unexpected",
  "context": {
    "batch_size": 100,
    "target": "https://shared-es.internal",
    "document_ids": ["doc1", "doc2"]
  },
  "retry_count": 3,
  "max_retries": 3,
  "failed_at": "2026-06-14T10:37:00Z",
  "stack_trace": "optional",
  "manual_review_required": true
}
```

---

## 9. API / Interfaces

### 9.1 REST API

Default port: `3000`.

#### Authentication
- `Authorization: Bearer *** header required for all endpoints.
- API keys are SHA-256 hashed and stored in `benchmarker-api-keys` index.
- Rate limit: 100 requests/min per key (configurable).

#### Endpoints

**`POST /api/v1/evaluate`** — Queue a model for evaluation
```json
{
  "model_id": "Qwen/Qwen3-70B",
  "hardware_profile": "A100-80GBx2",
  "eval_suites": ["tool_calls", "latency"],
  "vllm_config": {
    "flags": ["--tensor-parallel-size=4", "--quantization=fp8"],
    "source": "manual_override"
  },
  "priority": 999,
  "webhook_url": "https://hooks.slack.com/services/..."
}
```
Response: `201 Created`
```json
{
  "evaluate_id": "uuid",
  "model_id": "Qwen/Qwen3-70B",
  "status": "queued",
  "queue_position": 3,
  "estimated_start": "2026-06-14T12:00:00Z"
}
```

**`GET /api/v1/evaluate/:id`** — Check evaluation status
```json
{
  "evaluate_id": "uuid",
  "model_id": "Qwen/Qwen3-70B",
  "status": "queued | in-progress | completed | failed",
  "progress": {
    "current_stage": 2,
    "stage_name": "kibana_eval",
    "started_at": "2026-06-14T11:00:00Z"
  }
}
```

**`GET /api/v1/recommendations/:model_id`** — Get latest recommendation report (NEW)
```json
{
  "model_id": "Qwen/Qwen3-70B",
  "latest_report": { /* full recommendation-report document */ },
  "report_count": 3,
  "history_url": "/api/v1/recommendations/Qwen/Qwen3-70B/history"
}
```

**`GET /api/v1/models`** — List benchmarked models with latest verdict
Query params: `?filter=supported&sort=evaluated_at&limit=50`

**`GET /api/v1/queue`** — View queue status
```json
{
  "pending": 4,
  "in_progress": 1,
  "completed_today": 12,
  "items": [...]
}
```

**`GET /healthz`** — Service health
Returns `200` if local ES, EDOT collector, and GPU VM are reachable.

### 9.2 CLI

```bash
# Start daemon with discovery, eval, and API server
benchmarker start --config config.yaml --stage2 --stage3 --api-port 3000

# Queue manually
benchmarker enqueue --model "Qwen/Qwen3-70B" --profile "A100-80GBx2" --suites tool_calls,latency

# Get recommendation report for a model (NEW)
benchmarker recommend --model "Qwen/Qwen3-70B" --format json

# Bootstrap Kibana for Stage 2
benchmarker bootstrap-kibana --commit main

# Get reasoning for a completed run
benchmarker reasoning <run-id>

# Health check
benchmarker health-check --format json
```

### 9.3 Config File (YAML)

```yaml
api_server:
  port: 3000
  api_keys: ["${BENCHMARKER_API_KEY}"]
  rate_limit_rpm: 100
  cors_origins: ["https://dashboard.internal", "https://ci.elastic.dev"]

elasticsearch:
  url: "https://my-project.es.us-east-1.aws.elastic.cloud"
  api_key: "${ES_API_KEY}"
  # NOTE: Elastic Serverless is the SINGLE source of truth. No local ES. No SQLite.
  # All data: queue, results, traces, model history, health metrics, DLQ, recommendations.

golden_cluster:
  url: "https://shared-es.internal"
  api_key: "${GOLDEN_ES_API_KEY}"
  forward_enabled: true
  batch_size: 100
  flush_interval_sec: 300
  indices:
    public_benchmarks: "llm-benchmark-public"
    eval_traces: "*.eval-traces-*"

edot_collector:
  otlp_endpoint: "http://localhost:4318"
  health_url: "http://localhost:8080/healthz"
  container_id: "3084721cdd0466f68cd1d3df496a5c11bd68ef0919ddca1739d30255edc091a1"
  sampling_rate: 1.0
  trace_retention_days: 30

gpu_vms:
  - name: "benchmark-a100"
    host: "gpu-benchmark.internal"
    ssh_key: "${SSH_KEY_PATH}"
    hardware_profile: "A100-80GBx2"

recommendation:
  eval_suites:
    - name: "tool_calls"
      threshold: 0.85
      required: true
    - name: "skill_invocation"
      threshold: 0.80
      required: true
    - name: "latency"
      threshold: 0.70
      required: false
  near_threshold_window: 0.05  # +/- 5% = "investigate"
  notification:
    slack_webhook_url: "${SLACK_WEBHOOK_URL}"
    notify_on: ["support", "investigate"]

stage1:
  thresholds:
    max_p50_itl_ms: 200
    min_throughput_tps: 50
  concurrency_levels: [1, 2, 4, 8, 16]

stage2:
  kibana_repo_url: "https://github.com/elastic/kibana.git"
  kibana_commit: "main"
  default_eval_suites: ["tool_calls", "skill_invocation", "latency"]
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

### 9.4 Golden Forwarding

Forwarding rules unchanged. `recommendation-report` documents with
`verdict: support` are forwarded to the golden cluster as
`llm-benchmark-public` index entries.

---

## 10. Error Handling & Reliability

Scenarios unchanged from previous version. Key additions:

| Scenario | Behavior |
|---|---|
| Recommendation report generation fails | Log error. Write minimal report with `verdict: error` and `error_details`. Do NOT block pipeline — the run is still recorded in `benchmark-runs`. |
| Eval suite threshold not defined in config | Fail fast with clear error: "No threshold defined for suite 'foo'. Define in config.eval_suites or use --threshold." |
| Stage 1 passes but Stage 2 suite config mismatch | Emit `investigate` verdict with `blocking_issues: ["missing eval suite config"]`. Continue to Stage 3 reasoning. |

---

## 11. Security & Compliance

Unchanged.

---

## 12. Shared Scripts & Health Checks

Unchanged.

---

## 13. Milestones & Timeline

### Week 1: Foundation — Recommendation Report Artifact
- **Goal:** Produce a recommendation report for one manually queued model.
- Remove LangGraph stub; replace with explicit scheduler + ES queue loop.
- Fix hardware profile to match actual VM (2×A100-80GB).
- Implement `recommendation-report` index schema + write path.
- Stage 1: End-to-end `vllm bench serve` → ES write.
- Stage 2: Run one eval suite against vLLM endpoint (tool_calls MVP).
- Stage 3: Basic reasoning over Stage 1+2 results.
- CLI: `benchmarker recommend --model` returns latest report.
- **Deliverable:** A JSON recommendation report with a `verdict` for one model.

### Week 2: Conditional Gate + Multi-Suite Eval
- Stage 1 → Stage 2 conditional gate (reject early if gate fails).
- Multi-eval suite support (tool_calls + skill_invocation + latency).
- Configurable thresholds per suite.
- Trace-based reasoning (ES|QL queries over OTel traces).
- Slack webhook notification on `support` / `investigate` verdicts.
- **Deliverable:** Full three-stage pipeline for manually queued models.

### Week 3: Autonomy + Discovery Reconnection
- Reconnect `ModelDiscoveryService` to the pipeline with batched/parallel scanning.
- Autonomous discovery re-enablement (1-2 proposals/week).
- Hardware profile validation and rejection.
- Kibana dashboard for "Pending Decisions" panel.
- Service health monitoring and alerting.
- **Deliverable:** Service autonomously proposes models; PM gets notified and
  reviews recommendation reports.

### Week 4: Hardening + Phase 2 Abstraction
- Phase 2 abstraction boundary: extract Elastic-specific connectors (EIS, golden
  ES, private HF org) behind a pluggable interface.
- External user CLI path: `benchmarker recommend --hardware-profile` without
  Elastic-internal dependencies.
- Documentation and runbook.
- **Deliverable:** Pipeline is runnable by external users for self-hosting guidance.

---

## 14. Dependencies

Unchanged.

---

## 15. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| HF model cards are inconsistent / sparse | Parser has fallbacks. Hardware-profile defaults always available. |
| Kibana main is unstable at pinned commit | Pin to known-good tag. Update monthly. |
| GPU VM unavailable / SSH fails | Health check on startup. Alert if VM unreachable. Queue pauses. |
| HuggingFace API changes | Use `@huggingface/hub` client library. |
| Eval suites take too long | Configurable suite timeout. Parallel suite execution if supported. |
| Cloud LLM API costs spike | Reasoning is 1 call per evaluation. Track token usage. |
| **ES disk fills with 100% trace sampling** | ILM policy on trace indices. Daily rollover. |
| **EDOT Collector crashes / OOM** | Docker restart policy `always`. Health check API. |
| **Golden ES cluster rate limiting** | Batch writes. Use persistent queue fallback. |
| **PM ignores recommendation reports** | Slack notification + "Pending Decisions" Kibana panel. Make the artifact impossible to miss. |

---

## 16. Metrics & Success Criteria

| Metric | Target | Measurement |
|---|---|---|
| **Recommendation report production rate** | 100% of completed evaluations | Count of `recommendation-report` docs / count of completed runs |
| **PM decision time** | < 5 min per model | Self-reported or tracked via report view timestamps |
| **Autonomous proposal rate** | 1-2 models/week (M3+) | Count of models auto-added to queue by discovery |
| **HF card parse success rate** | > 90% | Models with successfully parsed vLLM config |
| **End-to-end pipeline success rate** | > 80% | Runs completing all stages without error |
| **Stage 1 → Stage 2 promotion rate** | 30-50% | Models passing performance gate |
| **Stage 2 → recommendation rate** | > 95% | Models producing a report after Stage 2 |
| **False support rate** | < 5% | Models with `support` verdict that later fail in production |
| **Dashboard freshness** | < 5 min lag | Time from run completion to dashboard update |
| **Service uptime** | > 99% | Daemon process availability |
| **False-negative rate** | < 5% | Good models that failed due to wrong vLLM config |
