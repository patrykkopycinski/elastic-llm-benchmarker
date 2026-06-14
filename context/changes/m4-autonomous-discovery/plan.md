# M4 Plan: Autonomous Discovery + Polish

## Objective
HF discovery runs continuously, suggests 1-2 models/week, hardware-aware filtering, manual queue override, golden cluster forwarding toggle.

## Tasks

### T1: Discovery Scheduler (HF API Polling)
**Location**: `src/services/discovery-service.ts`
**What**: Poll HuggingFace Hub API for trending text-generation models.
**Key behaviors**:
- Rate limit: max 1 request per 60 seconds (configurable)
- Filters: `pipeline_tag == "text-generation"`, downloads > 1000, has `config.json`
- Scoring: `score = (downloads_7d * 0.4) + (likes * 0.3) + (recency_days_penalty * 0.3)`
- Deduplication: skip if model already in `benchmark-queue` within last 30 days
- Enqueue: call `QueueService.enqueue({ modelId, source: 'discovery', priority: score })`

**Out of scope**: prefetching config.json; do it at queue time in Stage 1

**Tests**: `tests/unit/discovery-service.test.ts`

### T2: Hardware-Fit Estimation
**Location**: `src/services/hardware-estimator.ts`
**What**: Given HF config.json (layers, hidden_size, vocab_size, dtype), estimate GPU VRAM.
**Formula**: `params ≈ layers * hidden_size² * 12 + vocab_size * hidden_size` (simplified).
Then: `vram_gb ≈ params * dtype_bytes / 1e9 * 1.2` (20% overhead).
Compare against `config.hardware_profiles[].vram_gb`.
Return: `fit` (yes / no / maybe), `estimated_gb`, `profile_matches[]`.

**Tests**: `tests/unit/hardware-estimator.test.ts`

### T3: Manual Queue Override
**Location**: `src/cli.ts` + `src/services/queue-service.ts`
**What**: Add `benchmarker-queue submit <modelId>` subcommand.
- `--source` (default: 'user'), `--priority` (default: 0)
- Calls `QueueService.enqueue({ modelId, source, priority })`
- Prints queue item ID and estimated position

Also support REST-like direct enqueue in `QueueService` (already exists).

**Tests**: `tests/unit/queue-submit.test.ts`

### T4: Golden Cluster Forwarding
**Location**: `src/services/golden-forwarder.ts` + `src/services/elasticsearch-results-store.ts`
**What**: When `config.golden_cluster.forward_to_golden == true`, asynchronously replicate completed runs, evaluations, reasoning, and trace summaries to golden ES index.
- Use bulk API for efficiency
- Non-blocking: enqueue to in-memory queue, background flush every 30s
- On failure: retry 3× with exponential backoff, then drop + log warning
- Skip if golden cluster health check fails

**Tests**: `tests/unit/golden-forwarder.test.ts`

### T5: README + Operational Runbook
**Location**: `README.md` + `docs/ops-runbook.md`
- Architecture diagram (Mermaid)
- Setup instructions (local ES, EDOT, GPU VM)
- CLI reference
- Troubleshooting:
  - "Queue not moving" → check scheduler health, worker logs
  - "Stage 2 skipped" → check thresholds
  - "No trace data" → check EDOT collector
  - "Golden cluster failing" → check network + API key
- Alert thresholds for health-check script

### T6: Health-Check Enhancements
**Location**: `scripts/health-check.sh`
- Check scheduler process running (PID file)
- Check discovery last poll time < 2 hours
- Check golden-forwarder backlog size < 1000 items
- Exit non-zero + emit JSON to stdout for cron alerting

## Quality Gates
1. `npx tsc --noEmit` clean
2. `npx vitest run` all green
3. Discovery service unit tests cover rate-limiting, deduplication, scoring
4. Hardware estimator unit tests cover known models with real configs
5. Golden forwarder tests cover retry + drop behavior

## Upstream Dependencies
- M3 completed: Stage 3 worker, queue service, results store, config types
- `QueueService.enqueue()` API stable
- `ElasticsearchResultsStore` has `saveRun`, `saveEvalResult`, `saveReasoningResult`
