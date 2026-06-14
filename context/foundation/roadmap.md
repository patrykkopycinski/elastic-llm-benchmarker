# Roadmap: Elastic LLM Benchmarker

Derived from [PRD](prd.md). Delivery timeline: **4 weeks**, after-hours only.

---

## 10x Conventions

- **Change**: `context/changes/<change-id>/` contains all implementation artifacts for a milestone.
- **Goal**: Each change compiles to a green test suite and a functional demo.
- **Tests**: TDD — tests written before code, verified by CI.

---

## Milestones

### M1 — Pipeline Skeleton + Local Infrastructure (Week 1)
**Goal**: Worker can dequeue a model, run Stage 1 (vLLM bench serve), write results to local ES, and display in a basic Kibana dashboard.

**Changes required**:
1. **M1-C1** — Local ES + EDOT bootstrap scripts (`scripts/setup-local.sh`, `scripts/health-check.sh`, `scripts/setup-ilm.sh`)
2. **M1-C2** — Queue index schema + ES-backed polling scheduler (replace LangGraph with explicit loop)
3. **M1-C3** — Stage 1 worker: dequeue → SSH deploy → `vllm bench serve` → parse → write to `benchmark-runs`
4. **M1-C4** — vLLM Config Discovery: fetch HF card README + config.json + generation_config.json, extract vLLM flags, store in queue doc
5. **M1-C5** — Kibana dashboard (basic): index pattern `benchmark-runs`, visualizations for ITL/TTFT/throughput

**Exit criteria**:
- `scripts/health-check.sh` returns 0 for local ES + EDOT + GPU VM
- Scheduler polls `benchmark-queue` every 30s
- Stage 1 runs end-to-end on one manually queued model → results visible in Kibana within 5 minutes

**Risks**: SSH auth to GPU VM, vLLM warmup time. **Mitigation**: Test SSH first, add 10-min warmup timeout.

---

### M2 — Conditional Stage 2 + Kibana Eval Integration (Week 2)
**Goal**: Stage 2 only runs when Stage 1 passes thresholds. Eval suites clone Kibana main, bootstrap, run against vLLM endpoint, emit traces to local EDOT.

**Changes required**:
1. **M2-C1** — Threshold config + Stage 2 gating logic (ITL p50 < 200ms, throughput > 50 tps)
2. **M2-C2** — Kibana repo clone + bootstrap on worker node (caching, incremental)
3. **M2-C3** — Eval suite runner: execute selected suites (default: `tool_calls`, `latency`), collect scores, write to `benchmark-evaluations`
4. **M2-C4** — OTLP trace integration: eval suites emit traces to local EDOT collector, verify in `.benchmark-traces-*`
5. **M2-C5** — Dashboard update: add Stage 2 quality scores + trace explorer panel

**Exit criteria**:
- Model below threshold → Stage 2 skipped, log entry "Stage 1 performance below threshold"
- Model above threshold → Kibana eval suites run, traces visible in ES, scores in dashboard
- Evals complete without manual SSH into Kibana repo

**Risks**: Kibana bootstrap takes 20-30 min; eval suites may fail on new models. **Mitigation**: Cache `node_modules` between runs; mark eval failures as "eval error" not pipeline failure.

---

### M3 — Stage 3 Reasoning + Trace Queries (Week 3)
**Goal**: Stage 3 LLM reasoning with ES|QL trace analysis. Generates improvement suggestions stored in `benchmark-reasoning`.

**Changes required**:
1. **M3-C1** — ES|QL query builder: construct queries over `.benchmark-traces-*` for failure patterns, latency by operation
2. **M3-C2** — Reasoning prompt builder: Stage 1 + Stage 2 results + vLLM config + ES|QL trace summary → structured prompt
3. **M3-C3** — LLM invocation: cloud API (OpenAI/Anthropic) or local override; streaming response handling
4. **M3-C4** — Suggestion schema: structured output (prompt changes, temp/top-p, quantization, hardware switch)
5. **M3-C5** — Dashboard update: reasoning panel with suggestions + trace-derived failure patterns

**Exit criteria**:
- Stage 3 runs for every completed benchmark (pass or fail)
- ES|QL query returns trace stats before LLM call
- Suggestions include at least one concrete, actionable item (e.g., "reduce max-model-len to 64k" or "switch to AWQ")
- Dashboard displays suggestions linked to run ID

**Risks**: ES|QL syntax changes between ES versions; LLM hallucinates suggestions. **Mitigation**: Parse ES|QL response defensively; include vLLM config in prompt to ground suggestions.

---

### M4 — Autonomous Discovery + Polish (Week 4)
**Goal**: HF discovery runs continuously, suggests 1-2 models/week, hardware-aware filtering, manual queue override, golden cluster forwarding toggle.

**Changes required**:
1. **M4-C1** — Discovery scheduler: HF API polling with rate-limit respect (1 req/min), trending + recency scoring
2. **M4-C2** — Hardware-fit estimation: parse config.json layers × parameters × dtype → GPU memory, compare against profiles
3. **M4-C3** — Manual queue override: CLI `--queue-model org/name` and direct ES index write both work
4. **M4-C4** — Golden cluster forwarding: toggle `forward_to_golden: true`, replicate traces + results to golden ES
5. **M4-C5** — Documentation + operational runbook: README update, alert thresholds, rollback procedure

**Exit criteria**:
- Discovery suggests ≥1 model in a 7-day period that passes hardware fit
- `--queue-model` CLI flag works and model appears in queue after current run
- `forward_to_golden: true` replicates data to golden cluster without local disruption
- Service runs 7 days without manual intervention (monitored via health-check script)

**Risks**: HF API changes or rate limits; discovery suggests garbage. **Mitigation**: Filter by downloads > 1k, pipeline_tag == text-generation; log all suggestions for review.

---

## Cross-Cutting Concerns

### Testing Strategy
- **Unit**: HF card parser, vLLM flag extractor, ES|QL query builder (mock ES responses)
- **Integration**: health-check script against real local ES + EDOT; Stage 1 worker against mock SSH endpoint
- **E2E**: Full pipeline with `--queue-model` on a small model (e.g., `gpt2` for speed), verify all 3 stages complete
- **CI**: GitHub Actions runs unit + integration on PR; E2E runs nightly against local stack

### Operational Readiness (Before Merge)
- [ ] Health-check script in cron (every 5 min) + alerts on failure
- [ ] Log retention policy: 7 days stdout, 30 days ES
- [ ] Rollback: `git checkout <previous-tag>` + `systemctl restart benchmarker`
- [ ] Golden cluster forwarding tested with `forward_to_golden: true` in staging

### Deferred (Post-MVP)
- Hardware profile UI editing (currently config-only)
- Multi-GPU VM support (currently single profile)
- Custom eval suite authoring (currently uses Kibana suites only)
- Model variant comparison (AWQ vs GPTQ vs FP16)
- Multi-region benchmarking

---

## Dependencies by Milestone

| Milestone | Blockers |
|---|---|
| M1 | Local ES installed, GPU VM accessible via SSH, EDOT collector image pulled |
| M2 | Kibana main repo cloneable (< 2GB disk), eval suites known to work on vLLM endpoint |
| M3 | Cloud LLM API key available (OpenAI/Anthropic); ES 8.12+ with ES\|QL support |
| M4 | HF API key with elevated rate limits (or unauthenticated, slower) |

---

## Success Measurement

- **Week 1**: One model queued → Stage 1 completes → results in Kibana
- **Week 2**: One model passes gate → Stage 2 evals run → traces in ES
- **Week 3**: Stage 3 generates ≥1 actionable suggestion per run
- **Week 4**: Zero manual queue entries for 48h → discovery suggests and benchmarks autonomously
