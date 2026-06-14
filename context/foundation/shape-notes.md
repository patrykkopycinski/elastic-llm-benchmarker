---
project: Elastic LLM Benchmarker
context_type: brownfield
checkpoint:
  current_phase: 6
  phases_completed: [1, 2, 3, 4, 4.5, 5, 6]
  frs_drafted: 12
  quality_check_status: preparing
product_type: standalone-service
product_subtype: autonomous-eval-pipeline
target_scale:
  users: small
  description: Single internal team (~5-10 engineers) choosing OSS LLMs for GPU deployment
timeline_budget:
  delivery_weeks: 4
  after_hours_only: true
  hard_deadline: null
  mvp_acknowledged: 2026-06-14
updated: 2026-06-14
---

# Shape Notes: Elastic LLM Benchmarker — Autonomous Pipeline

## Current System

A standalone TypeScript application built around a LangGraph state machine:

- **Model discovery** (`src/services/model-discovery.ts`): Queries HuggingFace API
  to find promising open-source LLMs, filters by context window, license, and
  architecture. Currently orphaned — the discovery logic exists but is never
  invoked by the graph.
- **vLLM benchmark engine** (`src/engines/vllm-engine.ts`): SSH-deploys a model
  to a GPU VM, runs `vllm bench serve` at multiple concurrency levels, parses
  ITL/TTFT/throughput numbers. This is the most reliable component.
- **Elasticsearch store** (`src/es-store.ts`): Persists results across 6 indices
  (configs, runs, models, comparisons, evaluations, dashboard configs).
- **Kibana dashboards** (`kibana-dashboards/`): Pre-built dashboard definitions
  for visualizing benchmark results.
- **Kibana eval connector** (`src/kibana-eval/`): Partially stubbed attempts to
  pipe vLLM-served models into Kibana Agent Builder evals for quality scoring.
- **LangGraph pipeline** (`src/agent/`): Orchestrates the flow as a state graph
  with nodes for discovery, evaluation, benchmarking, storage, API exposure,
  and Kibana eval. In practice the graph is a linear pipeline with no-op
  defaults.

The system compiles and runs but the end-to-end value chain is broken:
discovery → evaluate → benchmark → store → dashboard does not execute
continuously or reliably.

## Vision & Problem Statement

**Pain**: The team runs GPU infrastructure for serving open-source LLMs but
choosing which models to deploy is manual, sporadic, and driven by Hacker News
rather than data. By the time a model is benchmarked, newer ones have already
shipped.

**Person**: ML-serving engineers (Patryk + teammates) who need to pick the
best open-source model for a given task + hardware combination without
wasting GPU hours on manual testing.

**Moment**: A new model drops (e.g., Qwen3, Mistral Small 3.1). The engineer
wonders: "Is this better than what we're running now? Will it fit on our
A100s? What's the ITL at our production concurrency?" Today they either skip
the check or spend half a day manually deploying and benchmarking.

**Cost today**: Manual SSH, manual vLLM deploy, manual `bench serve`, manual
spreadsheet tracking, stale results, no historical comparison.

**What changes**: A standalone service that continuously discovers promising
models, benchmark-tests them through a **three-stage conditional pipeline**:

1. **Stage 1 — Performance Benchmark**: Runs `vLLM bench serve` to measure
   ITL/TTFT/throughput. If results are below thresholds → stop and report.
2. **Stage 2 — Quality Eval (conditional)**: ONLY if performance is promising,
   the service clones Kibana main, bootstraps it, and runs specific Agent
   Builder eval suites (user-configurable which ones) to score model quality.
3. **Stage 3 — Reasoning**: Combines performance + quality results, uses an LLM
   to reason about what changes could improve eval scores, and reports both
   raw metrics and actionable suggestions.

All results stream into Elasticsearch for Kibana dashboards. The team views
results in Kibana, queues specific models, and the service handles the full
pipeline autonomously.

## User & Persona

**Primary persona**: ML-serving engineer / eval specialist (Patryk + teammates)
- Needs to know which model to deploy next
- Wants to compare models across BOTH speed (Stage 1) and quality (Stage 2)
  dimensions, with quality only evaluated on models that pass the speed gate
- Needs hardware-aware recommendations ("will this fit on our A100s?")
- Wants to override the autonomous queue with specific models
- Already runs Kibana eval suites manually today — wants this automated
- Wants to see improvement suggestions from reasoning (Stage 3) to tune
  prompts/configs and re-run for better scores

**Secondary persona**: Infra engineer
- Deploys and maintains the benchmark service
- Configures GPU hardware profiles and SSH credentials
- Monitors service health and queue backlog

## Access Control

**Current model**: No auth — standalone CLI tool.

**Planned change**: Service-level auth with ES security:
- Service authenticates to Elasticsearch with API key
- Queue management via ES documents (no custom auth layer)
- Results visible in Kibana through standard index patterns and dashboards
- SSH credentials stored in service config or environment (not in repo)

No custom RBAC — leverage ES/Kibana built-in security model.

## Success Criteria

### Primary
An ML engineer can open Kibana, see benchmark results in pre-built dashboards,
view the current queue status, and add a specific model to the queue. The
benchmark completes autonomously and results appear in dashboards within
24 hours.

### Secondary
- Autonomous discovery suggests 1-2 new promising models per week based on
  HuggingFace trending + context-window + hardware-fit filters.
- Hardware-aware filtering: models that won't fit on available GPU memory are
  flagged before queueing, not after a failed deploy.
- Service runs reliably without intervention for 7+ days.

### Guardrails
- Benchmarking never blocks production GPU workloads.
- Existing ES indices and dashboard definitions from the standalone app are
  preserved and enhanced, not replaced.
- No Kibana plugin code — adoption through dashboards and saved objects only.

## Functional Requirements

### Discovery
- FR-001: System can autonomously discover promising open-source models from
  HuggingFace. Priority: must-have. Change: modified (exists but orphaned).
- FR-002: Discovery filters by context window (min 128k), open-source license,
  and architecture (dense or MoE). Priority: must-have. Change: preserved.
- FR-003: Discovery filters by hardware fit — estimated GPU memory requirement
  vs. available benchmark hardware profiles. Priority: must-have. Change: new.
- FR-004: User can manually add a specific model to the evaluation queue
  (via a document in ES or CLI flag). Priority: must-have. Change: new.
- FR-005: Manually queued models are evaluated after the current in-flight
  evaluation completes (not immediately, to preserve VM stability).
  Priority: must-have. Change: new.

### Benchmark Execution
- FR-006: Worker deploys a model via SSH to a designated GPU VM and runs
  `vllm bench serve` at configurable concurrency levels. Priority: must-have.
  Change: preserved.
- FR-007: Worker parses ITL, TTFT, throughput, and generates a structured
  result document. Priority: must-have. Change: preserved.
- FR-008: Worker cancels or skips a benchmark if the model fails to deploy
  or crashes during warmup. Priority: must-have. Change: new.

### Quality Evaluation (Stage 2 — Conditional)
- FR-009: If Stage 1 performance is promising (above configurable thresholds
  for ITL/TTFT/throughput), the service clones the latest Kibana main repo,
  bootstraps dependencies, and runs user-selected Agent Builder eval suites
  against the vLLM-served model. Priority: must-have. Change: modified (was
  stubbed, now a conditional gate).
- FR-010: User can configure which eval suites run for Stage 2 (e.g.,
  `tool_calls`, `latency`, `skill_invocation`, `tokens`). Priority: must-have.
  Change: new.
- FR-011: Stage 2 writes quality scores, per-suite breakdowns, and trajectory
  traces to ES alongside Stage 1 results. Priority: must-have. Change: new.

### vLLM Configuration Discovery (Pre-Stage 1)
- FR-011-BIS: Before Stage 1 runs, the service MUST fetch and parse the
  HuggingFace model card README and any `config.json` and `generation_config.json`
  to extract model-specific deployment parameters. This includes: context length,
  recommended quantization format (AWQ, GPTQ, BF16, FP8), tool-call parser
  configuration, and any vLLM-specific flags (e.g., `--enable-reasoning`,
  `--reasoning-parser`, `--tool-call-parser`, `--allowed-local-media-path`).
  Priority: must-have. Change: new.
- FR-011-TER: The extracted configuration is stored in the queue document under
  `vllm_config` so the Stage 1 worker deploys with the correct settings.
  Priority: must-have. Change: new.
- FR-011-QUATER: If the model card specifies a recommended vLLM config, the
  service uses it as the default. If the card is silent, the service falls back
  to a hardware-profile-based default (e.g., BF16 for ≥80GB GPUs, INT8 for
  ≤24GB). Priority: must-have. Change: new.
- FR-011-QUINQUIES: Stage 3 reasoning MUST include vLLM config as an input
  dimension. If performance is poor, reasoning should suggest specific vLLM flag
  changes (e.g., "switch from BF16 to `--quantization=awq`", "increase
  `--max-model-len` to 128000 to match context window", "enable
  `--enable-reasoning` for reasoning accuracy"). Priority: must-have. Change: new.

### Reasoning (Stage 3)
- FR-012: After Stage 1 + Stage 2 complete, the service invokes an LLM with
  a structured prompt containing both performance metrics and quality scores,
  asking it to reason about what changes could improve the model's eval scores.
  Priority: must-have. Change: new.
- FR-013: Stage 3 outputs are stored in ES as "improvement suggestions" linked
  to the benchmark run. Suggestions include: prompt template changes, system
  prompt tweaks, temperature/top-p adjustments, quantization strategy changes.
  Priority: must-have. Change: new.

### Results & Visualization
- FR-014: All stage results (performance, quality, suggestions) are written to
  Elasticsearch and visible in Kibana via pre-built dashboards. Priority:
  must-have. Change: preserved.
- FR-015: Dashboard includes queue status, current stage, and per-run progress.
  Priority: must-have. Change: new.
- FR-016: User can queue a model by writing a document to ES (via API call
  or direct index write). Priority: must-have. Change: new.

## User Stories

### US-01: Autonomous discovery and three-stage benchmark
```
Given the benchmark service is running with discovery enabled
  and hardware profile "A100-80GB" is configured
When HuggingFace publishes a new model that matches the filters
  and fits within 80GB GPU memory
Then the model is automatically added to the pending queue
  and benchmarked through the full pipeline:
    - Stage 1: vLLM bench serve measures ITL/TTFT/throughput
    - Stage 2: Kibana eval suites run (if performance is promising)
    - Stage 3: LLM reasons about improvement suggestions
  and all results appear in Kibana dashboards.
  AND the vLLM deployment used the correct flags from the model card.
```

### US-02: Manual model queueing with full pipeline
```
Given a teammate hears about a new model on social media
When they write the HuggingFace model ID to the ES queue index
Then the model is added to the queue after the current evaluation
  and runs through ALL stages (performance → quality → reasoning)
  and a full report appears in dashboards when complete.
```

### US-03: Performance gate skips expensive eval
```
Given a model is queued and Stage 1 runs
When the model's ITL exceeds 500ms at batch size 8
Then Stage 2 is SKIPPED with a log entry:
  "Stage 1 performance below threshold; skipping quality eval."
  and Stage 3 provides reasoning limited to performance optimization.
```

### US-04: Dashboard three-stage view
```
Given the service is running and feeding results to ES
When a team member opens Kibana
Then they see pre-built dashboards showing:
  - Stage 1: Performance metrics (ITL/TTFT/throughput)
  - Stage 2: Quality scores per eval suite
  - Stage 3: Improvement suggestions with before/after projections
  - Queue status and current stage
  without installing any Kibana plugin.
```

## Business Logic

**The one-sentence rule**: The service automatically discovers promising
open-source LLMs and benchmark-tests them through a three-stage pipeline
(performance gate → quality eval → improvement reasoning), surfacing all
results in Kibana dashboards and reporting both raw metrics and actionable
suggestions.

**How it works**:
1. Service starts a scheduler (daemon loop, not cron — must react to queue
   changes immediately).
2. Discovery queries HuggingFace API for models matching filters (context window,
   license, pipeline_tag).
3. Each candidate is scored for "promisingness" (trending downloads, recency,
   architecture novelty).
4. Hardware-fit check: estimates GPU memory from config.json and compares
   against available profiles.
5. If the candidate passes the fit check and is not already in the queue or
   results index, **vLLM Configuration Discovery** fetches the model card,
   parsing README, config.json, and generation_config.json for recommended
   deployment parameters (context length, quantization, tool-call parser, etc.).
   The extracted config is stored in the queue document under `vllm_config`.
   If the card is silent, fallback to hardware-profile default.
6. **EDOT Health Check**: Before starting Stage 1, service verifies the local
   EDOT Collector is healthy (`/healthz`). All eval traces are sent locally first.
   If golden ES is configured, traces are also forwarded there as a secondary
   destination. If local collector is down, skip the run.
7. **Stage 1 — Performance**: Worker dequeues one model, reads `vllm_config`
   from the queue document, deploys it via SSH with the correct vLLM flags,
   runs `vllm bench serve`. If ITL/TTFT/throughput are below thresholds →
   mark as "failed gate", write Stage 1 results to **local ES**, run limited Stage 3, teardown.
8. **Stage 2 — Quality (conditional)**: If Stage 1 passes, worker keeps the
   model deployed, clones Kibana main, bootstraps, runs selected eval suites
   against the vLLM endpoint. Eval suites emit traces via OTLP to the local
   EDOT Collector, which stores them in **local ES** as native OTel data.
   If golden ES is configured, traces are replicated there. Quality scores are
   written to **local ES**.
9. **Stage 3 — Reasoning**: Service constructs a structured prompt with
   Stage 1 + Stage 2 results + model vLLM config. **Queries raw OTel traces**
   from **local ES** (e.g., `FROM .benchmark-traces-* | WHERE TraceId = ...`
   | STATS ...`) to understand why specific eval cases failed. Invokes an LLM
   to generate improvement suggestions, including potential new evaluators
   discovered from trace patterns. Stores suggestions in **local ES**.
10. Kibana dashboards (pointed at **local ES**) refresh automatically showing
    all three stages + raw trace explorer.
11. When ready, user can toggle a config flag to also forward all data to the
    **golden ES cluster** for sharing with the wider team.

### NFRs
- **Latency**: Dashboard data reflects latest benchmark within 5 minutes of
  completion.
- **Reliability**: Service must handle HF API rate limits, SSH disconnects,
  vLLM OOMs, and model download failures gracefully — logging the failure and
  moving to the next queue item without human intervention.
- **Observability**: Service emits structured logs to ES or stdout for
  ingestion; errors are visible in dashboards.
- **Security**: SSH credentials stored in environment or secure config, not in
  repo. ES API key for the service scoped to benchmark indices only.

## Constraints & Preserved Behavior

- **ES indices**: The 6 existing indices (`benchmark-configs`, `benchmark-runs`,
  `benchmark-models`, `benchmark-comparisons`, `benchmark-evaluations`,
  `kibana-dashboard-configs`) must be preserved. New fields may be added; old
  field semantics must not change.
- **vLLM engine**: The existing vLLM benchmark parsing and SSH orchestration
  logic is proven; changes should be additive (e.g., adding quality eval step)
  not rewrites.
- **Kibana compatibility**: Plugin code targets the current Kibana `main`
  branch; no backport commitments for now.
- **GPU isolation**: Benchmark VMs are separate from production serving VMs.
  The pipeline must never auto-deploy to production.
- **HuggingFace rate limits**: Discovery must respect HF API limits
  (authenticated requests, max 1 page per minute).

## Non-Goals

- **Avoid**: Building a Kibana plugin, custom app, or any frontend code inside
  Kibana. Adoption is through ES indices + dashboards only.
- **Avoid**: Recommending specific model variants (e.g., AWQ vs GPTQ vs FP16).
  The pipeline benchmarks whatever the user or discovery specifies; quantization
  strategy is out of scope.
- **Avoid**: Running benchmarks on non-NVIDIA GPUs. vLLM's CUDA-first nature
  means the worker assumes NVIDIA.
- **Avoid**: Building a model registry or artifact store. Models are downloaded
  directly from HuggingFace to the benchmark VM on each run; no caching layer.
- **Avoid**: Multi-region or multi-cloud benchmarking. Hardware profiles are
  per-cluster, not per-region.
- **Avoid**: Automated deployment to production. The pipeline evaluates only;
  promotion to production serving remains a human decision.
- **Avoid**: Offline-first or air-gapped support. Discovery requires HF API
  access; evals require Kibana connectivity.

## Forward: tech-stack

- Standalone TypeScript service (daemon or cron-based) for benchmarking
- Explicit scheduler over LangGraph state machine
- Elasticsearch as persistent queue + result store
- Pre-built Kibana dashboards (importable saved objects) for visualization
- Kibana eval integration as optional later stage
- No Kibana plugin code — adoption through dashboards only

## Open Questions

- [x] Q1: Quality eval uses Kibana Agent Builder evals (clone main, bootstrap,
  run suites). Stage 2 is conditional on Stage 1 passing thresholds.
  (Decided: 2026-06-14)
- [x] Q2: Stage 3 LLM reasoning endpoint: Cloud API (GPT-4/Claude) as default,
  with config override to local model. Rationale: reasoning quality matters most
  for eval improvement suggestions; costs are low (1 call per evaluation run).
  (Decided: 2026-06-14, assistant)
- [x] Q3: Kibana repo freshness: User pins a commit/tag in config. Service
  auto-pulls on startup; manual update when user changes the pin. Rationale:
  avoids main-branch fragility while keeping evaluations current.
  (Decided: 2026-06-14, assistant)
- [x] Q4: Stage 3 on Stage 1 failure: Always run, but prompt scope narrows.
  If Stage 2 never ran, reasoning focuses on performance optimization
  ("how to improve ITL/TTFT / will it fit on different hardware / try
  quantization"). If Stage 2 ran, reasoning covers both performance and
  eval-score improvements. (Decided: 2026-06-14, assistant)
- [x] Q5: Stage 2 eval suites: Both global default + per-model override.
  (Decided: 2026-06-14, assistant)
- [x] Q6: HuggingFace model card parsing for vLLM config is mandatory.
  Service parses README + config.json + generation_config.json to extract
  context length, quantization, tool-call parser, and vLLM flags. Fallback
  to hardware-profile defaults if card is silent. Stage 3 reasoning includes
  vLLM config dimension. (Decided: 2026-06-14, user + assistant)

## Decisions

- **Architecture**: Standalone TypeScript service (daemon), NOT a Kibana plugin.
  Kibana is a dependency for Stage 2 evals and a viewer for dashboards.
- **Pipeline stages**: 3 mandatory stages with Stage 2 gated conditionally.
  No more "optional" — all runs produce Stage 1; promising runs continue
  through Stage 2 + 3.
- **Quality eval**: Kibana Agent Builder eval suites, user-configurable which
  ones run per evaluation.
- **Hardware profiles**: Config-defined initially; UI editing postponed.
- **Queue mechanics**: ES-backed polling loop; no LangGraph.
- **Worker packaging**: Stripped TypeScript worker, deployed as systemd
  service or Docker container, SSHs from a CPU controller node to GPU VMs.
- **vLLM config discovery**: HuggingFace model card parsing is mandatory before
  Stage 1. Service extracts deployment parameters (context length, quantization,
  tool-call parser, vLLM flags) from README/config.json/generation_config.json.
  Fallback to hardware-profile defaults if card is silent. Stage 3 reasoning
  includes vLLM config as an input dimension.
- **Results target**: **Local ES cluster is PRIMARY** — all queue, results, and
  traces stored locally first. Golden ES cluster (`https://kbn-evals-serverless-ed035a...`)
  is an **optional secondary destination** for sharing trajectories. Toggle via
  `forward_to_golden: true/false` in config.
- **Trace infrastructure**: EDOT Collector is a **long-running Docker service**
  (non-blocking port, container ID `3084721cdd04...`). It receives OTLP from
  Stage 2 eval suites and stores traces in **local ES** as native OTel (PascalCase
  fields: `TraceId`, `SpanId`, `Attributes`, etc.). If `forward_to_golden: true`,
  traces are also replicated to the golden ES cluster. 100% sampling — zero
  dropping. Service health-checks collector before each run.
- **Stage 3 reasoning from traces**: In addition to eval summaries, Stage 3
  executes ES|QL queries over raw OTel traces to understand *why* eval cases
  failed and to mine patterns for new evaluator ideas.
- **Thread telemetry (OTel)**: Pipeline execution itself is instrumented with
  OTel traces (Discovery, HF Card Parse, Stage 1-3), linked via `TraceId` for
  end-to-end observability in the golden cluster.
- **OTel field naming**: Trace fields in ES are **PascalCase** (`TraceId`,
  `SpanId`, `ParentSpanId`, `Attributes`, `Duration`, `Name`). ES|QL queries
  must match exactly — lowercase returns zero rows silently.
