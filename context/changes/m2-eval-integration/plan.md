# M2 Plan: Conditional Stage 2 + Kibana Eval Integration

**Goal**: Stage 2 only runs when Stage 1 passes thresholds. Eval suites clone Kibana main, bootstrap, run against vLLM endpoint, emit traces to local EDOT.

**Upstream**: M1 pipeline skeleton
**Frozen interfaces**: `Stage1Result`, `PipelineRun`, `QueueService`, `ElasticsearchResultsStore`, `AppConfig`

---

## Acceptance Criteria

1. `Stage1Worker.execute()` emits `Stage1Result` with metrics.  
2. `Stage2Gate.check(stage1Result)` returns `{ proceed: true/false, reason }` based on `stage2Thresholds` in config.  
3. `KibanaRepoService` clones Kibana into `config.kibana_repo.cacheDir`, runs bootstrap once, reuses `node_modules` across evals.  
4. `EvalSuiteRunner` runs `@kbn/evals` suites (`tool_calls`, `latency`) against a vLLM endpoint URL, collects JSON scores, writes to `benchmark-evaluations` index.  
5. `Stage2Worker` chains: `gate → (if proceed) repoBootstrap → evalRunner → storeResults`.  
6. All eval traces emitted via OTLP to `config.edot_collector.url` and retrievable from `.benchmark-traces-*`.  
7. Pipeline run updates: `PipelineRun` gains `stage2Result?: Stage2Result`, worker tests cover gate + runner + full chain.

---

## Tasks (≈6, 3 parallel agent groups)

### T1 — Stage2Gate + Threshold Logic
**Files**: `src/worker/stage2-gate.ts`, `src/scheduler/pipeline-state.ts` (extend), tests  
**Details**:
- Read `stage2ThresholdsSchema` (already in `config.ts`)
- Implement `Stage2Gate.check(result: Stage1Result): { proceed: boolean; reason: string }`
  - Checks: `itl_p50_ms <= maxTtftMs` (use `itl_p50_ms` as proxy), `throughput_tps >= minThroughputTps`, `contextLength >= minContextWindow`
  - Return human-readable reason when blocked
- Add `Stage2Result` to `pipeline-state.ts`
- Unit tests: pass, fail-each-threshold, edge cases

### T2 — KibanaRepoService
**Files**: `src/services/kibana-repo-service.ts`, tests  
**Details**:
- Config mount: `config.kibana_repo { url, cacheDir, branch, bootstrapTimeoutMs }`
- `cloneOrPull()`: `git clone` if missing, `git fetch && git checkout <branch> && git pull` if exists
- `bootstrap()`: runs `yarn kbn bootstrap` from repo root; reuse `node_modules` if present
- `getRepoPath(): string`
- Errors: `KibanaRepoError` with `type: 'clone'|'checkout'|'bootstrap'`
- Unit tests: mock `child_process` for git + yarn commands

### T3 — EvalSuiteRunner
**Files**: `src/services/eval-suite-runner.ts`, tests  
**Details**:
- Runs eval suites via Node child_process against the Kibana repo
- Input: `{ repoPath, endpointUrl, suites: string[], modelId, timeoutMs }`
- Suites default: `['tool_calls', 'latency']`
- Command template: `node scripts/evals.js run --suite <suite> --endpoint <endpointUrl>` (or equivalent)
- Parse JSON output for scores, collect per-suite metrics
- Write results to ES `benchmark-evaluations` index via `ElasticsearchResultsStore` (extend store with `saveEvalResult`)
- OTel spans: wrap each suite run in a span, emit via existing OTLP setup
- Errors: `EvalSuiteError` with suite name + exit code + stderr excerpt
- Unit tests: mock child_process, verify ES write, verify span emission

### T4 — Stage2Worker
**Files**: `src/worker/stage2-worker.ts`, tests  
**Details**:
- Interface: `Stage2Worker { execute(run: PipelineRun, stage1Result: Stage1Result): Promise<Stage2Result> }`
- Dependencies: `Stage2Gate`, `KibanaRepoService`, `EvalSuiteRunner`, `ElasticsearchResultsStore`
- Steps:
  1. Gate check → if blocked, return `Stage2Result{status:'skipped', reason}`
  2. `KibanaRepoService.bootstrap()` (cached)
  3. `EvalSuiteRunner.run({ endpointUrl: run.deployment!.endpointUrl, ... })`
  4. Store results, update queue entry status
- `Stage2Result`: status, scores, suiteResults, tracesIndex, reason?
- Unit tests: mock all deps, verify skip + pass paths

### T5 — Scheduler Integration + Pipeline State Extension
**Files**: `src/scheduler/scheduler.ts`, `src/scheduler/pipeline-state.ts`, `src/cli.ts` (wire), tests  
**Details**:
- Extend `PipelineRun` with `stage2Result?: Stage2Result`
- Scheduler: after Stage1 completes, if success → check gate → if proceed → enqueue Stage2
  - Use same worker abstraction pattern as Stage1
- `Scheduler` now accepts `stage2Worker?: Stage2Worker` in constructor
- CLI `start` command: wire `stage2Worker` if `config.stage2Thresholds` present
- Integration test: full mock pipeline through Stage 1 + Stage 2

### T6 — ES Index Schema + Results Store Extension + Dashboard Update
**Files**: `src/services/es-index-mappings.ts`, `src/services/elasticsearch-results-store.ts`, `dashboard/`, tests  
**Details**:
- `benchmark-evaluations` index mapping: modelId, runId, suiteName, scores{}, timestamp, traceIds[]
- `benchmark-reasoning` index mapping stub (for M3): runId, modelId, esqlQuery, suggestions[]
- Extend `ElasticsearchResultsStore`:
  - `saveStage2Result(result: Stage2Result)`
  - `saveEvalResult(evalResult)` (used by EvalSuiteRunner)
- Dashboard NDJSON: add Stage 2 scores panel, trace explorer panel
- Unit tests for store extension

---

## Parallel Groups

- **Group A**: T1 + T2 (independent)
- **Group B**: T3 + T4 (T4 depends on T3 interface, but T3 can run in parallel if interface is frozen)
- **Group C**: T5 + T6 (T5 depends on T1-T4 types; T6 depends on T3 ES writes)

Optimal dispatch:
1. **Parallel**: T1, T2, T3
2. **Then**: T4 (requires T3 types), T6 (requires T3 + T1)
3. **Then**: T5 (requires T1-T4 types + scheduler wiring)

---

## Test Checklist

- [ ] `Stage2Gate` — pass, fail per threshold, edge cases
- [ ] `KibanaRepoService` — clone, pull, bootstrap reuse, error paths
- [ ] `EvalSuiteRunner` — suite execution, JSON parse, ES write, span emission
- [ ] `Stage2Worker` — skip path, full pass path, error recovery
- [ ] `Scheduler` — Stage1→Stage2 chain, maxConcurrent respected
- [ ] `ElasticsearchResultsStore` — Stage2 + eval writes, index creation
- [ ] Integration — mocked full pipeline 1+2

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Kibana bootstrap 20-30 min | Cache `node_modules`, incremental `git pull` |
| Eval suites fail on new models | Mark as `eval_error`, not pipeline failure |
| OTLP trace verification flaky | Use `search_logs` / `tail_logs` in test, not live collector |
| Config schema drift | Use existing `stage2ThresholdsSchema`, extend `kibana_repo` |
