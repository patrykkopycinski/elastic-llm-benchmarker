# M1: Pipeline Skeleton + Local Infrastructure

**Goal**: Worker dequeues a model, runs Stage 1 (HF card parse + vLLM bench serve), writes results to local ES, displays in Kibana dashboard. User can queue a model via CLI.

**Success Criteria**:
- `npm run health-check` exits 0 when local ES + EDOT are healthy
- `npm run cli -- --queue-model "Qwen/Qwen2.5-7B-Instruct"` adds model to queue
- Scheduler polls queue every 30s, picks up pending models
- Stage 1 completes full cycle: dequeue → HF parse → deploy → benchmark → store results
- Results visible in Kibana within 5 minutes of benchmark completion

---

## Architecture Decisions (Frozen — Do Not Change)

1. **LangGraph is deleted**. The new pipeline is an explicit state machine in `src/scheduler/`.
2. **Local ES is PRIMARY**. All writes go to `http://localhost:9200`. Golden cluster forwarding is M4.
3. **Queue polling over push**. Scheduler polls `benchmark-queue` index every 30s for `status:pending`.
4. **HF card parsing is mandatory**. Every queued model runs through the parser before deployment.
5. **vLLM config from HF card**. Extract `max_model_len`, `tensor_parallel_size`, quantization flags from README + config.json + generation_config.json.
6. **Health check before every run**. Local ES, EDOT collector, GPU VM SSH must all pass before Stage 1 starts.
7. **Existing code reuse**:
   - KEEP: `src/services/queue-service.ts`, `src/services/elasticsearch-results-store.ts`, `src/services/es-index-mappings.ts`, `src/services/ssh-client.ts`, `src/services/vllm-deployment.ts`, `src/services/benchmark-runner.ts`, `src/engines/vllm-engine.ts`, `src/services/health-check.ts`
   - DELETE: `src/agent/` (entire directory — graph, nodes, state, orchestrator)
   - DELETE: `src/services/benchmark-orchestration.ts` (replaced by scheduler)
   - MODIFY: `src/config/index.ts`, `src/types/config.ts`
   - CREATE: `src/scheduler/`, `src/services/hf-card-parser.ts`, `src/worker/stage1-worker.ts`, `scripts/`

---

## Task Breakdown (Agent-Executable)

### T1: Delete LangGraph + Create Scheduler Shell

**What to do**:
1. Delete `src/agent/` entirely (graph.ts, nodes.ts, state.ts, configurable.ts, interactive-orchestrator.ts, discovery-constants.ts, index.ts)
2. Delete `src/services/benchmark-orchestration.ts`
3. Create `src/scheduler/` directory with:
   - `scheduler.ts` — main polling loop (see interface below)
   - `pipeline-state.ts` — Stage 1-3 state machine types
   - `index.ts` — exports
4. Create `src/worker/` directory with:
   - `stage1-worker.ts` — Stage 1 execution (will be filled in T5)
   - `index.ts` — exports

**Interface (Frozen)**:

```typescript
// src/scheduler/pipeline-state.ts
export type PipelineStage = 'idle' | 'hf_parse' | 'deploy' | 'benchmark' | 'store' | 'done' | 'failed';

export interface PipelineRun {
  runId: string;
  modelId: string;
  queueEntryId: string;
  stage: PipelineStage;
  startedAt: string;
  completedAt?: string;
  error?: string;
  // Populated during run
  hfCard?: HFCardResult;
  deployment?: DeploymentInfo;
  benchmarkResult?: Stage1Result;
}

// src/scheduler/scheduler.ts
export interface SchedulerOptions {
  pollIntervalMs: number;        // default 30000
  maxConcurrentRuns: number;     // default 1
}

export class Scheduler {
  constructor(
    private queueService: QueueService,
    private stage1Worker: Stage1Worker,
    private options: SchedulerOptions,
  ) {}
  async start(): Promise<void>;   // begins polling loop
  async stop(): Promise<void>;    // graceful shutdown
}
```

**Acceptance Criteria**:
- `npm run typecheck` passes after deletions
- `npm run build` succeeds
- No references to LangGraph remain in codebase (verify with `grep -r "langgraph\|LangGraph" src/`)

**Test**:
```typescript
// tests/unit/scheduler.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler.js';

describe('Scheduler', () => {
  it('should poll queue at configured interval', async () => {
    // Mock queueService.pollPending() → returns entry, then empty
    // Verify stage1Worker.execute called once
  });
  
  it('should respect maxConcurrentRuns', async () => {
    // Queue 3 entries, maxConcurrent=1
    // Verify only 1 stage1Worker.execute active at a time
  });
});
```

**Dependencies**: None (can run in parallel with T2, T3, T4)

---

### T2: Update Config Schema for Local-First Architecture

**What to do**:
1. Expand `src/types/config.ts` with new schema (see interface below)
2. Update `src/config/index.ts` to load new schema
3. Add `appConfigSchema` zod validation for new fields
4. Default `forward_to_golden: false`

**Interface (Frozen)**:

```typescript
// src/types/config.ts — additions only (keep existing types)
export interface GoldenClusterConfig {
  url: string;
  apiKey: string;
  forward_to_golden: boolean;
}

export interface EDOTCollectorConfig {
  otlp_endpoint: string;           // http://localhost:4318
  health_url: string;              // http://localhost:8080/healthz
  container_id?: string;
  sampling_rate: number;           // 1.0 = 100%
  trace_retention_days: number;    // 30
  golden_otlp_endpoint?: string;   // optional forwarding
}

export interface KibanaRepoConfig {
  url: string;
  commit: string;
}

export interface Stage2Thresholds {
  max_itl_p50_ms: number;          // default 200
  min_throughput_tps: number;      // default 50
}

// Add to AppConfig:
//   golden_cluster?: GoldenClusterConfig;
//   edot_collector: EDOTCollectorConfig;
//   kibana_repo: KibanaRepoConfig;
//   stage2_thresholds: Stage2Thresholds;
```

**Acceptance Criteria**:
- `npm run typecheck` passes
- Config loads from `config/default.json` with new schema
- Missing required fields throw clear errors at startup
- `forward_to_golden` defaults to `false`

**Test**:
```typescript
// tests/unit/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

describe('Config', () => {
  it('should default forward_to_golden to false', () => {
    const config = loadConfig({ configPath: 'config/test-minimal.json' });
    expect(config.golden_cluster?.forward_to_golden).toBe(false);
  });
  
  it('should require edot_collector fields', () => {
    expect(() => loadConfig({ configPath: 'config/test-missing-edot.json' }))
      .toThrow(/edot_collector/);
  });
});
```

**Dependencies**: None (can run in parallel with T1, T3, T4)

---

### T3: Create Bootstrap Scripts

**What to do**:
Create `scripts/` directory with three executable bash scripts:

1. **`scripts/health-check.sh`** — Infrastructure validation gate
   - Check local ES: `curl -s http://localhost:9200/_cluster/health | grep -q '"status":"green\|yellow"'`
   - Check EDOT collector: `curl -s http://localhost:8080/healthz | grep -q "ok"`
   - Check GPU VM SSH: `ssh -o ConnectTimeout=5 -o BatchMode=yes $VM_HOST echo ok`
   - Exit 0 if all pass, exit 1 with stderr diagnostic if any fail
   - Reads config from `config/default.json` (parse with `jq`)

2. **`scripts/setup-local.sh`** — One-command local stack bootstrap
   - Start local ES via Docker: `docker run -d --name es-local -p 9200:9200 -e "discovery.type=single-node" -e "xpack.security.enabled=false" elasticsearch:8.12.0`
   - Start EDOT collector via Docker (reusable `start-edot.sh`)
   - Wait for health-check to pass
   - Run `scripts/setup-ilm.sh`
   - Print "Local stack ready" or "Failed: <reason>"

3. **`scripts/setup-ilm.sh`** — Trace index lifecycle policy
   - Create ILM policy `.benchmark-traces-ilm`:
     - Hot phase: rollover at `max_size: 50gb` OR `max_age: 1d`
     - Delete phase: after 30 days
   - Create index template `.benchmark-traces-template` with `index_patterns: [".benchmark-traces-*"]`
   - Create initial index `.benchmark-traces-000001` (is_write_index: true)
   - Verify with `GET _ilm/policy/.benchmark-traces-ilm`

**Acceptance Criteria**:
- `bash scripts/setup-local.sh` brings up ES + EDOT in < 2 minutes
- `bash scripts/health-check.sh` returns 0 after setup-local completes
- `bash scripts/setup-ilm.sh` creates ILM policy + index template + write index
- All scripts are executable (`chmod +x`)
- Scripts exit with clear error messages (not just exit codes)

**Test**:
```bash
# tests/integration/scripts.test.sh (run manually or via bash)
#!/bin/bash
set -e
scripts/setup-local.sh
scripts/health-check.sh
scripts/setup-ilm.sh
curl -s http://localhost:9200/_ilm/policy/.benchmark-traces-ilm | grep -q "benchmark-traces-ilm"
echo "PASS"
```

**Dependencies**: None (standalone infrastructure)

---

### T4: HF Card Parser Service

**What to do**:
Create `src/services/hf-card-parser.ts` that:
1. Fetches `https://huggingface.co/{modelId}/raw/main/README.md`
2. Fetches `https://huggingface.co/{modelId}/raw/main/config.json`
3. Fetches `https://huggingface.co/{modelId}/raw/main/generation_config.json`
4. Parses all three into structured vLLM config

**Interface (Frozen)**:

```typescript
// src/services/hf-card-parser.ts
export interface HFCardResult {
  modelId: string;
  architecture: string;              // from config.json: architectures[0]
  contextLength: number;             // from config.json: max_position_embeddings
  quantization: string[];            // from README badges or config.json torch_dtype
  tensorParallelSize: number;        // heuristic: if params > 30B → 2, > 70B → 4
  maxModelLen?: number;              // from generation_config.json max_new_tokens or README
  vllmFlags: string[];               // derived flags: --enforce-eager, --enable-chunked-prefill, etc.
  toolCallParser?: string;           // from README: "hermes", "llama", "qwen" patterns
  gpuMemoryRequired?: number;        // GB, from README or heuristic
  parsedFrom: {
    readme: boolean;
    configJson: boolean;
    generationConfigJson: boolean;
  };
  warnings: string[];                // e.g., "No generation_config.json found, using defaults"
}

export class HFCardParser {
  async parse(modelId: string): Promise<HFCardResult>;
  
  // Exposed for testing
  extractVllmFlags(config: unknown, readme: string): string[];
  detectToolCallParser(readme: string): string | undefined;
  estimateGpuMemory(params: number, dtype: string): number;
}
```

**Parsing Rules (Frozen)**:
- `architecture`: `config.json.architectures[0]` or `config.json.model_type`
- `contextLength`: `config.json.max_position_embeddings` || `config.json.max_seq_length` || `config.json.n_positions` || 4096 (default)
- `quantization`: If README contains "AWQ" → ["awq"], "GPTQ" → ["gptq"], "GGUF" → ["gguf"], else [`config.json.torch_dtype` || "fp16"]
- `tensorParallelSize`: params > 70B → 4, > 30B → 2, else 1. Override if README says "requires multi-GPU"
- `vllmFlags`: 
  - If `architecture` contains "moe" → add `--enable-chunked-prefill`
  - If `quantization` includes "awq" → add `--quantization awq`
  - If `quantization` includes "gptq" → add `--quantization gptq`
  - Always add `--dtype auto`
- `toolCallParser`: README contains "function calling" + "hermes" → `"hermes"`, + "llama" → `"llama"`, + "qwen" → `"qwen"`

**Acceptance Criteria**:
- Parses `Qwen/Qwen2.5-7B-Instruct` correctly (qwen2, 131072, fp16, tp=1)
- Parses `meta-llama/Llama-3.1-70B-Instruct` correctly (llama, 131072, fp16, tp=4)
- Returns warnings when generation_config.json is missing (do not fail)
- All fetches timeout after 10s (do not hang on bad model IDs)
- `npm run test -- tests/unit/hf-card-parser.test.ts` passes

**Test**:
```typescript
// tests/unit/hf-card-parser.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HFCardParser } from '../../src/services/hf-card-parser.js';

describe('HFCardParser', () => {
  it('should parse Qwen2.5-7B correctly', async () => {
    const parser = new HFCardParser();
    // Mock fetch or use nock
    const result = await parser.parse('Qwen/Qwen2.5-7B-Instruct');
    expect(result.architecture).toBe('qwen2');
    expect(result.contextLength).toBe(131072);
    expect(result.tensorParallelSize).toBe(1);
  });
  
  it('should estimate tp=4 for 70B models', async () => {
    const parser = new HFCardParser();
    const flags = parser.extractVllmFlags(
      { architectures: ['LlamaForCausalLM'], torch_dtype: 'bfloat16' },
      'Llama 3.1 70B'
    );
    expect(flags).toContain('--tensor-parallel-size 4');
  });
  
  it('should warn on missing generation_config.json', async () => {
    // Mock 404 for generation_config.json
    // Verify warnings array contains expected message
  });
});
```

**Dependencies**: None (pure service, no ES/scheduler dependency)

---

### T5: Stage 1 Worker

**What to do**:
Create `src/worker/stage1-worker.ts` that executes the full Stage 1 pipeline:

```
dequeue model → HF parse → deploy vLLM → health check → benchmark → store results → teardown
```

**Interface (Frozen)**:

```typescript
// src/worker/stage1-worker.ts
export interface Stage1Result {
  runId: string;
  modelId: string;
  queueEntryId: string;
  status: 'success' | 'failed' | 'skipped';
  hfCard: HFCardResult;
  metrics: {
    itl_p50_ms: number;
    itl_p99_ms: number;
    ttft_ms: number;
    throughput_tps: number;
    duration_sec: number;
  } | null;
  rawOutput: string;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface Stage1Worker {
  execute(run: PipelineRun): Promise<Stage1Result>;
}

export function createStage1Worker(
  hfParser: HFCardParser,
  vllmEngine: VllmEngine,
  resultsStore: ElasticsearchResultsStore,
  healthCheck: HealthCheckService,
  config: AppConfig,
): Stage1Worker;
```

**Execution Flow (Frozen)**:
1. Call `hfParser.parse(run.modelId)` → fill `run.hfCard`
2. Call `healthCheck.runInfraChecks()` → if fail, abort with `error: "Infra health check failed"`
3. Call `vllmEngine.deploy(sshConfig, model, hardwareProfile)` → fill `run.deployment`
4. Call `healthCheck.pollUntilHealthy()` → timeout 10 min, retry every 10s
5. Call `vllmEngine.runBenchmarks(...)` → parse output → fill metrics
6. Write result to `benchmarker-results` index via `resultsStore`
7. Call `vllmEngine.stop()` → teardown
8. Return `Stage1Result`

**Acceptance Criteria**:
- Worker handles full pipeline without manual intervention
- If deployment fails, result status is `failed` with error message, deployment is still torn down
- If benchmark fails after deployment success, teardown still runs
- Metrics are parsed from vLLM benchmark output (ITL, TTFT, throughput)
- Result is written to ES with `@timestamp` field

**Test**:
```typescript
// tests/unit/stage1-worker.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createStage1Worker } from '../../src/worker/stage1-worker.js';

describe('Stage1Worker', () => {
  it('should complete full pipeline on success', async () => {
    // Mock all dependencies
    // Verify result.status === 'success'
    // Verify resultsStore.saveBenchmark called
    // Verify vllmEngine.stop called
  });
  
  it('should teardown even if benchmark fails', async () => {
    // Mock benchmark to throw
    // Verify result.status === 'failed'
    // Verify vllmEngine.stop still called
  });
  
  it('should skip if infra health check fails', async () => {
    // Mock healthCheck to fail
    // Verify result.status === 'skipped'
    // Verify vllmEngine.deploy NOT called
  });
});
```

**Dependencies**: T1 (scheduler types), T2 (config), T4 (HF parser), existing VllmEngine + HealthCheck + ResultsStore

---

### T6: Wire CLI → Scheduler → Worker

**What to do**:
1. Rewrite `src/cli.ts` to:
   - Load config
   - Initialize ES client
   - Initialize scheduler with stage1Worker
   - Commands:
     - `start` — start scheduler (blocking)
     - `queue <modelId>` — add model to queue, exit
     - `health-check` — run `scripts/health-check.sh`, exit with same code
     - `setup-local` — run `scripts/setup-local.sh`
2. Wire `src/index.ts` to export scheduler + worker factories

**CLI Interface (Frozen)**:

```bash
node dist/cli.js start              # Start scheduler polling loop
node dist/cli.js queue <modelId>    # Add model to queue
node dist/cli.js health-check       # Validate infrastructure
node dist/cli.js setup-local        # Bootstrap ES + EDOT
```

**Acceptance Criteria**:
- `npm run build && node dist/cli.js health-check` returns 0 when stack is up
- `node dist/cli.js queue "Qwen/Qwen2.5-7B-Instruct"` creates entry in `benchmark-queue`
- `node dist/cli.js start` begins polling and processes queued models
- Ctrl+C gracefully shuts down scheduler (finishes current run, then exits)

**Test**:
```typescript
// tests/integration/cli.test.ts
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

describe('CLI', () => {
  it('should queue a model', () => {
    const out = execSync('node dist/cli.js queue "test/model"').toString();
    expect(out).toContain('Queued');
  });
});
```

**Dependencies**: T1, T2, T5

---

### T7: Kibana Dashboard Export

**What to do**:
1. Create `dashboard/` directory with Kibana saved objects NDJSON:
   - Index pattern: `benchmarker-results`
   - Visualizations:
     - ITL p50/p99 over time (line chart)
     - Throughput by model (bar chart)
     - Pass/fail ratio (pie chart)
     - Recent runs table
2. Add `npm run dashboard:import` script that:
   - Reads `dashboard/benchmarker-dashboard.ndjson`
   - POSTs to `http://localhost:5601/api/saved_objects/_import`
3. Add `npm run dashboard:export` script for updating the export

**Acceptance Criteria**:
- `npm run dashboard:import` creates all objects in local Kibana
- Dashboard shows data from `benchmarker-results` index
- All visualizations render without errors
- Export can be regenerated with `npm run dashboard:export`

**Test**:
```bash
# Manual verification:
npm run dashboard:import
# Open http://localhost:5601/app/dashboards
# Verify "LLM Benchmarker Overview" dashboard exists and shows data
```

**Dependencies**: T1 (local ES), T6 (results being written)

---

### T8: Integration Test — Full M1 Pipeline

**What to do**:
Create `tests/integration/m1-pipeline.test.ts` that:
1. Mocks SSH + vLLM (use existing mock patterns from `tests/unit/vllm-engine.test.ts`)
2. Creates ES client against `http://localhost:9200`
3. Queues a model via QueueService
4. Runs scheduler for one iteration
5. Verifies:
   - `benchmark-queue` entry status = `completed`
   - `benchmarker-results` doc exists with parsed metrics
   - `benchmarker-checkpoints` has deployment + benchmark events

**Test Setup (Frozen)**:
```typescript
// Use testcontainers or manual ES setup
// Mock SSHClientPool to return canned benchmark output
// Mock HFCardParser to return static result (avoid real HF fetches in CI)
```

**Acceptance Criteria**:
- Test passes in CI (GitHub Actions) with local ES in Docker
- Test completes in < 2 minutes
- All ES indices are cleaned up after test (delete test docs)

**Dependencies**: All previous tasks

---

## Dependency Graph

```
T3 (scripts) ─────────────────────────┐
T4 (HF parser) ───┐                    │
T2 (config) ──────┼──► T5 (worker) ───┼──► T6 (CLI) ───► T7 (dashboard)
T1 (scheduler) ───┘                    │                    ▲
                                       └────────────────────┘
                                                          │
T8 (integration) ◄────────────────────────────────────────┘
```

**Parallel tasks**: T1, T2, T3, T4 can all run simultaneously.
**Sequential**: T5 depends on T1+T2+T4. T6 depends on T5. T7 depends on T6. T8 depends on all.

---

## Agent Assignment Strategy

| Agent | Tasks | Why |
|-------|-------|-----|
| Agent A | T1 + T3 | Infrastructure — no TypeScript dependency |
| Agent B | T2 + T4 | Type definitions + pure service (parallel) |
| Agent C | T1 (scheduler) + T5 | Scheduler types → Worker (needs scheduler interface) |
| Agent D | T6 + T7 + T8 | CLI wiring + Dashboard + Integration (needs all above) |

---

## File Inventory

### Delete
- `src/agent/` (entire directory)
- `src/services/benchmark-orchestration.ts`

### Create
- `src/scheduler/scheduler.ts`
- `src/scheduler/pipeline-state.ts`
- `src/scheduler/index.ts`
- `src/worker/stage1-worker.ts`
- `src/worker/index.ts`
- `src/services/hf-card-parser.ts`
- `scripts/health-check.sh`
- `scripts/setup-local.sh`
- `scripts/setup-ilm.sh`
- `dashboard/benchmarker-dashboard.ndjson`
- `tests/unit/scheduler.test.ts`
- `tests/unit/hf-card-parser.test.ts`
- `tests/unit/stage1-worker.test.ts`
- `tests/integration/m1-pipeline.test.ts`

### Modify
- `src/types/config.ts` — add new interfaces
- `src/config/index.ts` — load new schema
- `src/cli.ts` — rewrite commands
- `src/index.ts` — export new modules
- `package.json` — add scripts: `health-check`, `setup-local`, `dashboard:import`, `dashboard:export`

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SSH to GPU VM fails | Medium | High | Test SSH manually first; add retry logic in worker |
| vLLM benchmark output format changes | Low | Medium | Parse defensively with regex fallback |
| Local ES Docker startup slow | High | Low | `setup-local.sh` waits with timeout + retry |
| HF API rate limit | Medium | Low | Cache parsed cards in `benchmarker-models` index; parse once per model |
| Kibana dashboard import fails | Low | Medium | Manual import fallback via Kibana UI |

---

## Notes for Agents

1. **Do NOT modify existing services** (QueueService, ResultsStore, VllmEngine, SSHClient) unless the plan explicitly says so. Wrap/adapt them instead.
2. **All new code must have tests**. If a module has no test file, it's not done.
3. **Type safety is mandatory**. `npm run typecheck` must pass after every task.
4. **Mock external APIs in tests**. Do not hit HuggingFace or real GPU VMs in unit tests.
5. **ES indices**: Use existing `INDEX_NAMES` from `es-index-mappings.ts`. Do not create new index names without updating the mappings file.
6. **Config precedence**: CLI args > env vars > config file > defaults. Follow existing pattern in `src/config/index.ts`.
