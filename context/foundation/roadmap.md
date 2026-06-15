# Roadmap: Elastic LLM Benchmarker

Derived from [PRD](prd.md). Delivery timeline: **4 weeks**, after-hours only.

---

## 10x Conventions

- **Change**: `context/changes/<change-id>/` contains all implementation artifacts for a milestone.
- **Goal**: Each change compiles to a green test suite and a functional demo.
- **Tests**: TDD — tests written before code, verified by CI.

---

## Milestones

### M1 — Recommendation Report Artifact (Week 1)
**Goal**: Fix the four execution gaps and produce a recommendation report with a `verdict` for one manually queued model.

**Current state**: ~33K-line codebase exists with vLLM engine, HF discovery, ES store, queue API, EDOT collector, and golden cluster forwarding. The pipeline is 90% built but produces dashboards, not decisions.

**Execution gaps to close:**
1. **Hardware profile mismatch.** `config/default.json` specifies `nvidia-l4` / 1 GPU. Actual VM is 2×A100-80GB. Update the profile.
2. **Queue consumer split.** `benchmarker-queue` is a separate binary that must be started manually. Integrate queue polling into the main `benchmarker start` daemon.
3. **LangGraph stub.** `langgraph.json` points to a 212-char stub. Delete `src/agent/graph.ts` and `langgraph.json`. The scheduler already exists in `src/scheduler/index.ts`.
4. **Orphaned discovery.** `ModelDiscoveryService` scans 1,000 HF candidates sequentially and times out. Refactor to batched/parallel scanning with early exit. Discovery is deferred to M3; M1 focuses on manual queueing.

**Changes required:**
1. **M1-C1** — Fix hardware profile: update `config/default.json` → `A100-80GBx2`; validate profile against VM on startup.
2. **M1-C2** — Merge queue daemon into `benchmarker start`: integrate `src/api/queue-server.ts` into the main CLI daemon lifecycle.
3. **M1-C3** — Remove LangGraph: delete `src/agent/graph.ts`, `langgraph.json`, and any LangGraph dependencies.
4. **M1-C4** — `recommendation-report` index schema + write path: implement the schema from PRD §8, wire into pipeline after Stage 3 (or after Stage 1 early-exit).
5. **M1-C5** — CLI `benchmarker recommend --model <id>`: query `recommendation-report` and return latest report as JSON.
6. **M1-C6** — Stage 1 end-to-end: manual queue → deploy → benchmark → gate → write report (reject if gate fails, support/investigate if pass).

**Exit criteria:**
- `benchmarker start` boots scheduler + queue API in one process (no separate `benchmarker-queue` binary needed).
- `config/default.json` hardware profile matches the VM (2×A100-80GB).
- No `langgraph.json` or `src/agent/graph.ts` in repo.
- One manually queued model runs through Stage 1 → produces a `recommendation-report` document with `verdict: reject` or `verdict: investigate`.
- `benchmarker recommend --model <id>` returns that report.

**Risks**: SSH auth to GPU VM, vLLM warmup time. **Mitigation**: Test SSH first, add 10-min warmup timeout.

---

### M2 — Quality Eval + Conditional Gate (Week 2)
**Goal**: Stage 2 only runs when Stage 1 passes thresholds. Eval suites clone Kibana main, bootstrap, run against vLLM endpoint. Recommendation report includes eval scores.

**Changes required:**
1. **M2-C1** — Threshold config + Stage 2 gating logic (ITL p50 < 200ms, throughput > 50 tps). Gate must be explicit: "reject" report if gate fails.
2. **M2-C2** — Kibana repo clone + bootstrap on worker node (caching, incremental).
3. **M2-C3** — Eval suite runner: execute selected suites (default: `tool_calls`, `skill_invocation`), collect scores, write to `benchmark-evaluations`.
4. **M2-C4** — OTLP trace integration: eval suites emit traces to local EDOT collector, verify in `.benchmark-traces-*`.
5. **M2-C5** — Recommendation report enrichment: include `passing_evals[]`, `blocking_issues[]`, and final `verdict` (support / investigate / reject).

**Exit criteria:**
- Model below threshold → Stage 2 skipped, report has `verdict: reject` with `reason: stage1_gate_failed`.
- Model above threshold → Kibana eval suites run, traces visible in ES, scores in recommendation report.
- Evals complete without manual SSH into Kibana repo.
- `verdict: support` only emitted when ALL configured eval suites pass thresholds.

**Risks**: Kibana bootstrap takes 20-30 min; eval suites may fail on new models. **Mitigation**: Cache `node_modules` between runs; mark eval failures as "eval error" not pipeline failure.

---

### M3 — Trace-Based Reasoning + Autonomous Discovery (Week 3)
**Goal**: Stage 3 LLM reasoning with ES|QL trace analysis. Reconnect ModelDiscoveryService for autonomous proposals. Notification on `support`/`investigate` verdicts.

**Changes required:**
1. **M3-C1** — ES|QL query builder: construct queries over `.benchmark-traces-*` for failure patterns, latency by operation.
2. **M3-C2** — Reasoning prompt builder: Stage 1 + Stage 2 results + vLLM config + ES|QL trace summary → structured prompt.
3. **M3-C3** — LLM invocation: cloud API (OpenAI/Anthropic) or local override; streaming response handling.
4. **M3-C4** — Suggestion schema: structured output (prompt changes, temp/top-p, quantization, hardware switch, vLLM flag changes).
5. **M3-C5** — Discovery reconnection: batched/parallel HF scanning with early exit. Discovery writes to queue; scheduler picks up.
6. **M3-C6** — Notification system: Slack webhook (configurable) on `support` or `investigate` verdicts with link to recommendation report.

**Exit criteria:**
- Stage 3 runs for every completed benchmark (pass or fail).
- ES|QL query returns trace stats before LLM call.
- Suggestions include at least one concrete, actionable item (e.g., "reduce max-model-len to 64k" or "switch to AWQ").
- Discovery service finds ≥1 qualifying model in a 7-day window, queues it, pipeline runs autonomously.
- Slack notification fired with report link.

**Risks**: ES|QL syntax changes between ES versions; LLM hallucinates suggestions. **Mitigation**: Parse ES|QL response defensively; include vLLM config in prompt to ground suggestions.

---

### M4 — Phase 2 Abstraction + Operational Hardening (Week 4)
**Goal**: Extract Elastic-specific dependencies behind a pluggable interface so external users can run the pipeline. Full operational readiness.

**Changes required:**
1. **M4-C1** — Phase 2 abstraction boundary: define `Connector` interface for ES, HF, LLM, notification. Implement `ElasticConnector` (internal) and `LocalConnector` (external).
2. **M4-C2** — External CLI path: `benchmarker recommend --hardware-profile "A100-80GBx2" --task "tool-calling"` without Elastic-internal dependencies.
3. **M4-C3** — Service health monitoring: cron health-check, alerting thresholds, dashboard for queue depth and error rates.
4. **M4-C4** — Golden cluster forwarding toggle: `forward_to_golden: true` tested in staging.
5. **M4-C5** — Documentation + operational runbook: README update, deployment guide, rollback procedure.

**Exit criteria:**
- Pipeline runs with `--connector local` flag and no Elastic-internal env vars set.
- Service runs 7 days without manual intervention (monitored via health-check script).
- `forward_to_golden: true` replicates data to golden cluster without local disruption.
- README includes Phase 2 quickstart for external users.

**Risks**: External path diverges from internal path. **Mitigation**: Keep core pipeline identical; only connectors differ. Test both paths in CI.

---

## Cross-Cutting Concerns

### Testing Strategy
- **Unit**: HF card parser, vLLM flag extractor, ES|QL query builder, recommendation report builder (mock ES responses).
- **Integration**: health-check script against real local ES + EDOT; Stage 1 worker against real GPU VM (SSH).
- **E2E**: Full pipeline with `benchmarker enqueue` on a small model (e.g., `gpt2` for speed), verify all 3 stages complete and produce a recommendation report.
- **CI**: GitHub Actions runs unit + integration on PR; E2E runs nightly against staging stack.

### Operational Readiness (Before Merge)
- [ ] Health-check script in cron (every 5 min) + alerts on failure
- [ ] Log retention policy: 7 days stdout, 30 days ES
- [ ] Rollback: `git checkout <previous-tag>` + `systemctl restart benchmarker`
- [ ] Golden cluster forwarding tested with `forward_to_golden: true` in staging

### Deferred (Post-MVP)
- Hardware profile UI editing (currently config-only)
- Multi-GPU VM support (currently single profile, though VM has 2 GPUs)
- Custom eval suite authoring (currently uses Kibana suites only)
- Model variant comparison (AWQ vs GPTQ vs FP16) — report includes one config, not a matrix
- Multi-region benchmarking
- REST API authentication & rate limiting (currently basic bearer token)

---

## Dependencies by Milestone

| Milestone | Blockers |
|---|---|
| M1 | Local ES installed, GPU VM accessible via SSH, EDOT collector image pulled, LLM API key for Stage 3 testing |
| M2 | Kibana main repo cloneable (< 2GB disk), eval suites known to work on vLLM endpoint |
| M3 | Cloud LLM API key available (OpenAI/Anthropic); ES 8.12+ with ES\|QL support; Slack webhook for notifications |
| M4 | External user hardware profile (can use same VM for testing); staging golden cluster access |

---

## Post-MVP / Continuous Improvements

| Feature | Status | Notes |
|---|---|---|
| Docker support for benchmarker app | ✅ Shipped | Multi-stage Dockerfile, docker-compose, tsup CLI entry points |
| E2E smoke test script | ✅ Shipped | `scripts/smoke-test.sh` validates all infra without disrupting existing vLLM |
| Recommendation report artifact | 🔄 M1 | Primary output; PRD §8 schema |
| Phase 2 external connector | 🔄 M4 | Pluggable interface for non-Elastic environments |
| Hardware profile UI editing | 🔄 Backlog | Currently config-only |
| Multi-GPU VM support | 🔄 Backlog | Currently single profile |
| Custom eval suite authoring | 🔄 Backlog | Currently uses Kibana suites only |
| Model variant comparison | 🔄 Backlog | AWQ vs GPTQ vs FP16 |
| Multi-region benchmarking | 🔄 Backlog | Needs additional VM infrastructure |

---

## Success Measurement

| Week | Target |
|---|---|
| Week 1 (M1) | One model manually queued → recommendation report produced with `verdict`. CLI `recommend` returns report. |
| Week 2 (M2) | Conditional gate works: slow model rejected quickly; good model runs full evals and gets `support`/`investigate` verdict. |
| Week 3 (M3) | Autonomous discovery finds ≥1 model, pipeline runs end-to-end without manual queue entry. Slack notification fires. |
| Week 4 (M4) | External path (`--connector local`) runs on same VM and produces recommendation report. Service runs 7 days without manual intervention. |
