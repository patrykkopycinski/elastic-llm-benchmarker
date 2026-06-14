# M3 Plan: Stage 3 Reasoning + Trace Queries

## Context
Upstream: M2 complete. Stage 2 conditional eval pipeline runs end-to-end. ES indices exist for runs, evaluations, stage2 results. PipelineRun type has `benchmarkResult?: Stage1Result`, `stage2Result?: Stage2Result`. No reasoning infrastructure yet.

## Tasks

### T1: ES|QL Query Builder + Trace Analyzer
**File**: `src/services/trace-query-builder.ts`
**Interface**:
```typescript
export interface TraceQueryBuilder {
  buildFailurePatternQuery(modelId: string, runId: string, timeRange: { from: string; to: string }): string;
  buildLatencyByOperationQuery(modelId: string, runId: string, timeRange: { from: string; to: string }): string;
  buildSummary(modelId: string, runId: string, timeRange: { from: string; to: string }): Promise<TraceSummary>;
}

export interface TraceSummary {
  totalSpans: number;
  errorCount: number;
  topErrors: Array<{ operation: string; count: number; sampleMessage: string }>;
  latencyPercentiles: { p50_ms: number; p95_ms: number; p99_ms: number };
  operations: Array<{ name: string; count: number; avgDurationMs: number; errorRate: number }>;
}
```
- `buildFailurePatternQuery`: queries `.benchmark-traces-*` for `Attributes.model_id == "{modelId}"` AND `Status.Code == "Error"`, groups by `Name`, counts, returns ES|QL string
- `buildLatencyByOperationQuery`: queries `.benchmark-traces-*` for `Attributes.model_id == "{modelId}"`, aggregates `Duration` (nanos → ms) by `Name`, returns p50/p95/p99
- `buildSummary`: executes both queries against ES client, returns `TraceSummary`
- **IMPORTANT**: OTel field names in ES are **PascalCase**: `TraceId`, `SpanId`, `Attributes`, `Duration`, `Name`, `Status`
- ES client comes from constructor config (same as other services)
- `buildSummary` must catch ES|QL errors and return a degraded summary (fallback to empty if both queries fail)

**Tests**: `tests/unit/trace-query-builder.test.ts` — mock ES client, test query string generation, test buildSummary success and degraded fallback.

### T2: Reasoning Prompt Builder
**File**: `src/services/reasoning-prompt-builder.ts`
**Interface**:
```typescript
export interface ReasoningPromptBuilder {
  build(opts: {
    pipelineRun: PipelineRun;
    vllmConfig: HFCardResult;
    stage1Result: Stage1Result;
    stage2Result: Stage2Result;
    traceSummary: TraceSummary;
  }): string;
}
```
- Produces structured markdown prompt with sections:
  1. **Model Info**: model_id, architecture, context length, quantization, GPU memory required
  2. **vLLM Deployment Config**: flags used, max_model_len, tensor_parallel_size
  3. **Stage 1 Performance**: ITL p50/p99, TTFT, throughput, duration
  4. **Stage 2 Eval Results**: overall status, per-suite scores, pass/fail counts
  5. **Trace Analysis**: total spans, error count, top errors, latency percentiles
  6. **Instructions**: "You are a vLLM performance optimization expert. Analyze results and suggest 1-3 concrete improvements. Each suggestion must be actionable and include estimated impact."
- Prompt length capped at ~8k tokens (approximate character limit 32k chars)
- Must handle missing data gracefully (e.g., if stage2Result is undefined, say "Stage 2 was not run")

**Tests**: `tests/unit/reasoning-prompt-builder.test.ts` — test full prompt generation, test missing stage2, test length limit, test each section present.

### T3: LLM Client
**File**: `src/services/llm-client.ts`
**Interface**:
```typescript
export interface LlmClient {
  complete(opts: {
    systemPrompt?: string;
    userPrompt: string;
    model?: string; // default from config
    temperature?: number;
    maxTokens?: number;
    responseFormat?: 'json' | 'text'; // default text
  }): Promise<LlmResponse>;
}

export interface LlmResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string;
  model: string;
}
```
- Implementation uses OpenAI-compatible API (`openai` npm package or fetch to `{apiBase}/v1/chat/completions`)
- Config fields in `src/types/config.ts`: `llmApiKey`, `llmBaseUrl`, `llmModel` (default `'gpt-4o'`)
- Support streaming? No — blocking call with 120s timeout is fine for M3.
- If LLM call fails, throw with a clear error message (caller in Stage 3 will catch)
- **No new production dependency**: check if `openai` is already a dependency; if not, implement with `fetch` only.

**Tests**: `tests/unit/llm-client.test.ts` — mock fetch, test successful completion, test error handling, test JSON response format.

### T4: Stage 3 Worker (Orchestrator)
**File**: `src/worker/stage3-worker.ts`
**Interface**:
```typescript
export interface Stage3Worker {
  execute(run: PipelineRun): Promise<Stage3Result>;
}
```
- Constructor deps: `{ config, traceQueryBuilder, promptBuilder, llmClient, resultsStore, logger }`
- `execute()` logic:
  1. Extract `runId`, `modelId`, `stage1Result`, `stage2Result` from `run`
  2. Call `traceQueryBuilder.buildSummary(modelId, runId, timeRange)` — timeRange from `startedAt`/`completedAt`
  3. Call `promptBuilder.build({ pipelineRun: run, vllmConfig: run.hfCard!, stage1Result: run.stage2Result, stage2Result: run.stage2Result, traceSummary })`
  4. Call `llmClient.complete({ systemPrompt, userPrompt: prompt, responseFormat: 'json' })`
  5. Parse JSON from LLM response (attempt to extract JSON block from markdown if wrapped)
  6. Build `Stage3Result`: `status: 'success'`, `suggestions[]`, `rawResponse`, `traceSummary`
  7. Call `resultsStore.saveReasoningResult(result)` (ignore errors)
  8. Return `Stage3Result`
- **Never throws** — all errors caught, returned as `Stage3Result` with `status: 'error'` and `reason`
- Handles case where `run.hfCard` is missing (use empty object / defaults)

**Type additions** (`src/scheduler/pipeline-state.ts`):
```typescript
export interface Stage3Result {
  runId: string;
  modelId: string;
  status: 'success' | 'error';
  suggestions?: Array<{
    category: 'config' | 'quantization' | 'hardware' | 'other';
    title: string;
    description: string;
    estimatedImpact: 'high' | 'medium' | 'low';
  }>;
  traceSummary?: TraceSummary;
  rawResponse?: string;
  error?: string;
  startedAt: string;
  completedAt: string;
}
```

**Add** `stage3Result?: Stage3Result` to `PipelineRun` interface.

**Tests**: `tests/unit/stage3-worker.test.ts` — mock all deps, test success path, test trace summary failure (degraded), test LLM failure, test missing hfCard.

### T5: Scheduler + CLI Integration
**File**: `src/scheduler/scheduler.ts`, `src/cli.ts`, `src/services/index.ts`, `src/worker/index.ts`
- Extend Scheduler constructor: add optional `stage3Worker?: Stage3Worker`
- In polling loop, AFTER Stage 2 completes (or if Stage 2 was skipped), invoke Stage 3:
  ```typescript
  if (stage3Worker && run.status !== 'failed' /* still run on skipped stage 2 */) {
    run.stage3Result = await stage3Worker.execute(run);
    // Stage 3 failure doesn't fail the pipeline run
  }
  ```
- Extend `start` command in CLI:
  - Add `--stage3` flag (only meaningful when `--stage2` is also passed, but can run standalone after Stage 1)
  - When `--stage3`, instantiate `Stage3WorkerImpl` with all deps and pass to scheduler
- Extend `resultsStore` (`src/services/elasticsearch-results-store.ts`) with `saveReasoningResult(result: Stage3Result)`
- Extend ES index mappings (`src/services/es-index-mappings.ts`) for `benchmark-reasoning-*`

### T6: Dashboard Update
- Update `dashboard/benchmarker-dashboard-m2.ndjson` (or create M3 version) adding:
  - **Reasoning Suggestions** panel: table of suggestions by model_id with category badges
  - **Trace Summary** panel: summary metrics (error counts, latency percentiles) from `benchmark-reasoning-*`

## Verification
- `npx tsc --noEmit` clean
- `npx vitest run` all green (new unit tests + existing)
- TraceQueryBuilder produces valid ES|QL (visually inspect, don't require live ES)
- Prompt builder output readable, all sections present
- Stage3Worker NEVER throws

## Frozen (do not change)
- PipelineRun interface shape (only add optional fields)
- Stage1Result, Stage2Result interfaces
- QueueService signatures
- Existing tests
