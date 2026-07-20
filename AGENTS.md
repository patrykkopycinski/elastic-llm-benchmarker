# `elastic-llm-benchmarker` — Agent Onboarding

## Project Overview

Autonomous LLM benchmarking pipeline. Discovers models from HuggingFace, runs vLLM benchmarks on GPU VMs via SSH, evaluates with Kibana's own eval suites, stores everything in Elasticsearch, and publishes curated results to a shared golden cluster.

**Architecture**: TypeScript daemon, Elastic Serverless as single source of truth, REST API for CI/dashboards, kbn/evals traces forwarded to golden cluster via Buildkite.

## Quick Start

```bash
# Prerequisites: Node.js 20+, Elastic Serverless API key, GPU VM accessible via SSH
git clone https://github.com/patrykkopycinski/elastic-llm-benchmarker.git
cd elastic-llm-benchmarker
npm install
npx tsc --noEmit              # typecheck
npx vitest run                # unit tests

# Start full pipeline
cp config.example.yaml config.yaml
# Edit config.yaml with your ES, SSH, and GPU VM credentials
npm run start -- --config config.yaml --stage2 --stage3 --api-port 3200
```

## Critical Project Rules

1. **Unified persistence**: Elastic Serverless is the primary store. No SQLite. No local ES instance. All data (queue, results, traces, DLQ, model history) lives in the serverless cluster.
2. **Forward-only shared cluster**: The shared/golden ES cluster is write-only. Only kbn/evals trace data is forwarded (via the Buildkite eval pipeline); we never read from golden.
3. **Never throw in services**: All service methods return structured results with `.success`, `.error`, `.data`. Internal errors are logged and returned, never thrown.
4. **Queue API surface**: Services talk to each other via `QueueService` with exactly four methods: `enqueue()`, `claim()`, `complete()`, `fail()`. No `add()` or `initialize()`.
5. **SSH as black box**: The GPU VM is reached only via `SSHClientPool` in `src/services/ssh-client.ts`. No direct SSH calls outside this service.
6. **OTel field casing**: EDOT `traces-*` indices use semconv ES|QL names (`trace.id`, `@timestamp`, `duration`, `span.name`, `status.code`, `attributes.*`). Override via `edotCollector.traceIndexPattern` / `EDOT_COLLECTOR_TRACE_INDEX_PATTERN`.
7. **Stage 2 runs only on Stage 1 pass**: `stage2_thresholds` gate must be met before Kibana eval suites execute. When `buildkite.enabled`, Stage 2 is **real Kibana CI evals** via Buildkite — local `eval-suite-runner.ts` is skipped.
8. **Golden cluster scope**: Only kbn/evals OTel traces land on golden ES — not benchmark results or recommendation reports. `GoldenForwarder` is not on the happy path.
9. **API keys are SHA-256 hashed**: Never store plaintext API keys in ES. Use `crypto.createHash('sha256').update(key).digest('hex')` for comparison.
10. **No orphaned services**: If a service is not referenced on the happy path (start → scheduler → worker → store → forwarder), delete it. Do not keep dead code.
11. **Agent Builder baseline gate**: Models must pass `agentBuilderBaseline` before enqueue/discovery (see below). Use `--force` on manual enqueue to override. Parallel/multi-tool calling is **not** required — Agent Builder uses single-tool calls only.
12. **NEVER stop the GPU VM**: The GPU VM is **ephemeral — stopping it destroys it permanently** (no persistent disk to restart from). Never run `gcloud compute instances stop/suspend/delete`, cloud-console Stop, or `ssh <vm> 'shutdown/poweroff/halt/reboot'`. "Stop the benchmarker" always means the **local daemon** (`./scripts/stop-local.sh` / `benchmarker-queue stop`) or the vLLM container — never the host. If you think the VM must stop, ask the operator first and state that stopping = permanent loss. See rule `never-stop-benchmarker-gpu-vm`.

## Agent Builder Baseline (model selection gate)

Derived from [elastic/security-team#15545](https://github.com/elastic/security-team/issues/15545) Model Evaluation Log, adjusted for Agent Builder: **single-tool calling only** (no parallel tool requirement).

| Criterion | Default | Hard? | Notes |
|-----------|---------|-------|-------|
| `minContextWindow` | 128_000 | yes | Long-context security evals |
| `minParameterCountBillions` | 24 | yes | Sub-24B open-weight models fail agentic tool-calling for security in our matrix runs (split-signal: skill loaded, prescribed tools skipped). 24B keeps Mistral-Small-24B (European coverage) + Qwen3-30B-A3B; excludes the 8–14B tier. Sweet spot for 2×A100-80GB is 24–70B. Gates on TOTAL params. |
| `minActiveParametersBillions` | 8 | no (warn) | MoE active (per-token) param floor. `minParameterCountBillions` over-states MoE capacity ~10×: Qwen3.6-35B-A3B (35B total, ~3B active) clears the 24B total floor but fails the same agentic evals a dense 24B passes. WARN-only — never hard-rejects — because Ornith-1.0-35B (same ~3B-active arch) passes every suite; capability beats count. Active params read from the `-A{N}B` naming convention (Qwen3.6-35B-A3B, Qwen3-235B-A22B, Kimi-Linear-48B-A3B). Set to 0 to disable. |
| `requireToolCalling` | true | yes | Known vLLM parser (hermes/mistral/llama3_json) |
| `requireInstructVariant` | true | no (warn) | `instruct`, `chat`, or `-it` in model id — OR a known vLLM tool-call parser (capability beats naming; a name-only hard gate rejected Ornith-1.0-35B, the best-evaluated model in the matrix, so this criterion never hard-rejects) |
| VRAM fit + vLLM arch | — | yes | Existing `ModelCandidateFilter` logic |

Config block: `agentBuilderBaseline` in `config/default.json`. Wired on **enqueue** (`runEnqueue`), **discovery** (`DiscoveryScheduler`), via `createAgentBuilderFilter()` in `src/services/agent-builder-baseline.ts`. Post-benchmark, **Stage 1 itself** runs the single-tool `ToolCallBenchmarkService` (over an SSH tunnel to the VM's firewalled vLLM port) and gates **Stage 2 eligibility** on the param-count-aware floor via `resolveMinToolCallSuccessRate` (`minToolCallSuccessRate` / `minToolCallSuccessRateTiers`), not parallel calls. A below-floor success rate hard-gates; a null result (benchmark skipped or failed-open on tunnel/infra error) does not gate. (`ModelEvaluationEngine` is a richer scorer that is not on the happy path.)

To sweep smaller models for research, set `minParameterCountBillions: 8` or `agentBuilderBaseline.enabled: false` — never the default for CI eval runs.

## Directory Layout

```
src/
  cli.ts                  # CLI entry point (vLLM config + start/stop/enqueue/reasoning/health)
  scheduler/
    scheduler.ts           # 30s polling loop, chains Stage 1 → 2 → 3
  worker/
    stage1-worker.ts       # SSH → GPU VM → vllm serve → benchmark
    stage2-worker.ts       # Clone Kibana → bootstrap → eval suites
    stage3-worker.ts       # LLM reasoning over traces (Stage 3)
  services/
    elasticsearch-results-store.ts   # ES persistence — ALL data goes here
    queue-service.ts                 # Queue abstraction over ES docs
    ssh-client.ts                    # SSHClientPool
    discovery-scheduler.ts           # HF API polling + auto-queue
    hardware-estimator.ts            # GPU memory estimation
    vllm-deployment.ts               # Docker vLLM deploy on GPU VM (latest image, TP=all GPUs)
    system-health-check.ts           # Health checks for all deps
    trace-query-builder.ts           # ES|QL query builder
    reasoning-prompt-builder.ts      # Stage 3 prompt construction
    llm-client.ts                    # Native fetch-based LLM client
    es-index-mappings.ts             # ES index definitions
  types/
    config.ts                        # Zod-validated AppConfig
    
tests/
  unit/                   # Vitest unit tests (mock all external deps)
  integration/            # Integration tests (real ES, mock GPU VM)
  e2e/                    # End-to-end tests (TBD)

dashboard/
  benchmarker-dashboard.ndjson       # Kibana saved objects (import via UI)
  reasoning-dashboard.ndjson         # Stage 3 reasoning dashboard
  generate-dashboard.ts              # Dashboard generation script

context/
  foundation/
    prd.md                # This PRD + architecture
    roadmap.md            # M1–M4 milestones
    shape-notes.md        # 10x shaping notes
```

## Project Conventions

### Folder Structure
- `src/services/` — Business logic services (e.g., `queue-service.ts`). Export a class or factory function.
- `src/worker/` — Pipeline stage workers. Export a class implementing the stage interface.
- `src/scheduler/` — Orchestration logic. Export scheduler classes.
- `src/api/` — Express routers and server setup.
- `src/cli/` — CLI command handlers.
- `src/engines/` — Deployment engines (vLLM, Ollama stubs). Export an engine class.
- `src/types/` — Shared TypeScript interfaces and types.
- `src/utils/` — Utility functions. Export individual functions, not classes.
- `src/config/` — Configuration loading and validation.
- `src/scripts/` — One-off scripts (not part of the main pipeline).
- `tests/unit/` — Unit tests. Mirror `src/` structure. Name: `{module-name}.test.ts`.

### Naming Conventions
- **Files**: kebab-case (`queue-service.ts`, `stage1-worker.ts`).
- **Services**: PascalCase class name matching file name (`QueueService` in `queue-service.ts`).
- **Utilities**: camelCase function names (`createLogger`, `parseModelId`).
- **Types/Interfaces**: PascalCase, explicit `export interface` or `export type`.
- **Tests**: Co-located in `tests/unit/` with same kebab-case name + `.test.ts`.

### Export Patterns
- Services: `export class ServiceName { ... }`
- Utilities: `export function utilityName(...) { ... }`
- Types: `export interface TypeName { ... }`
- Index barrels: `src/services/index.ts`, `src/types/index.ts`, etc. Re-export public API.

### Error Handling
- Never throw inside services. Return `{ success: boolean, error?: string, data?: T }`.
- Log errors via `winston` logger (from `src/utils/logger.ts`).

## Type Safety

1. **Explicit return types on exports**: Every exported function, method, and class must have an explicit return type annotation. Private/internal helper functions may use inference.
2. **No `any`**: Use `unknown` instead of `any`. If `any` is unavoidable, add an `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment with a justification.
3. **Type imports**: Always use `import type { ... }` for types used only at compile time. ESLint enforces this.
4. **Zod at boundaries**: Use Zod schemas to validate all external data (API payloads, ES responses, CLI arguments, config files).

## Stack & Tooling

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript 5.5 |
| Testing | Vitest (unit), Playwright (e2e — TBD) |
| Lint/Type | ESLint + `@typescript-eslint` + `tsc --noEmit` |
| ES Client | `@elastic/elasticsearch` |
| SSH | `ssh2` |
| Validation | Zod (`AppConfig` schema) |
| Container | Docker + Docker Compose for EDOT collector |
| Package Manager | npm |

## Testing Conventions

- Unit tests mock ALL external dependencies (ES, SSH, HF API, LLM API). Use `vi.mock()` for external modules.
- Integration tests use a test Elastic Serverless project or ES Docker container, but mock GPU VM SSH.
- E2E tests are currently TBD.
- Test files live in `tests/unit/` or `tests/integration/` with `.test.ts` extension.
- Fixtures go in `tests/fixtures/`.

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `ES_API_KEY` | Local Elasticsearch API key |
| `GOLDEN_ES_API_KEY` | Shared/golden ES cluster API key |
| `SSH_KEY_PATH` | Path to SSH private key for GPU VM |
| `HF_TOKEN` | HuggingFace token (for authenticated API, higher rate limits) |
| `ANTHROPIC_API_KEY` | Stage 3 reasoning LLM API key |
| `BENCHMARKER_API_KEY` | REST API authentication key |

## Common Tasks for Agents

### Add a new ES index
1. Define mapping in `src/services/es-index-mappings.ts`
2. Add index name to `ensureIndices()` in `src/services/elasticsearch-results-store.ts`
3. Add Zod schema in `src/types/config.ts` if the index has typed documents
4. Write unit tests in `tests/unit/elasticsearch-results-store.test.ts`
5. Run `npx tsc --noEmit` and `npx vitest run`

### Add a new CLI command
1. Add handler function in `src/cli/<command>-handler.ts`
2. Wire command in `src/cli.ts` using `commander`
3. Add completion logic if the command finishes or errors
4. Write unit tests in `tests/unit/<command>-handler.test.ts`
5. Run `npx tsc --noEmit` and `npx vitest run`

### Add a new service
1. Create file in `src/services/<service>.ts`
2. Export a class or factory function with typed return values
3. NEVER throw internally — return `{ success: boolean, error?: string, data?: T }`
4. Add tests in `tests/unit/<service>.test.ts`
5. Ensure the service is instantiated and used on the happy path, or delete it

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '@kbn/setup-node-env'` | You are in a fresh git worktree. Run `npm run bootstrap` or `yarn kbn bootstrap` if inside Kibana repo. For this project, just `npm install`. |
| ES connection refused | Check `elasticsearch.url` in config. Should point to your Elastic Serverless endpoint. |
| SSH timeout | Verify `gpu_vms` config, SSH key permissions (`chmod 600`), and VM network connectivity. |
| Golden forwarder queue growing | Check `benchmarker-errors` index for Buildkite eval forwarding failures. Likely 429 or 503 from shared ES. |
| Dashboard/API port conflict | Default API port is **3200** — avoid **3100** (patryks-treadmill). Override with `--api-port`. |
| Local ES port conflict | Dev ES in `config/default.json` uses port **9223** — not 9200 or 9220. |
| Type errors in tests | Check that mocks match new service signatures. Update `__mocks__/` if needed. |

## Security Rules

1. **Never commit credentials**: SSH passwords, private keys, API tokens, and `.env` files must never be committed. Use `.env.example` for documentation only.
2. **Placeholder-only committed config**: `config/default.json`, `config/smoke-full.json`, and docs must use placeholders (`your-gpu-vm-host`, `your_ssh_user`, `/path/to/your/ssh/key`) — never real VM IPs, usernames, or home-directory key paths. Copy to `config/local.json` (gitignored) for operator values.
3. **Never log secrets**: Winston loggers must redact sensitive fields (`password`, `apiKey`, `token`, `privateKey`). Use a structured log serializer.
4. **Config schemas expose field shapes, not values**: The Zod schema for `ssh.password` and `ssh.privateKeyPath` documents what the app accepts — never put real values in committed config files.
5. **API key hashing**: When storing or comparing API keys, always hash with SHA-256. Never store plaintext in Elasticsearch or config files.
6. **Golden cluster is write-only**: Read access is prohibited. This prevents accidental leakage of shared eval data back into local contexts.

## Type Safety Rules

1. **Explicit return types on exports**: Every exported function, method, and class must have an explicit return type annotation. Private/internal helpers may use inference.
2. **No `any`**: Use `unknown` instead of `any`. If `any` is unavoidable, add an `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment with a justification.
3. **Type imports**: Always use `import type { ... }` for types used only at compile time. ESLint enforces this.
4. **Zod at boundaries**: Use Zod schemas to validate all external data (API payloads, ES responses, CLI arguments, config files).

## Remember

- **This is a daemon service**, not a library. The entry point is `src/cli.ts start` which starts a persistent process.
- **The golden cluster is not yours.** You write to it; you don't manage it. All querying, queueing, and history lives in Elastic Serverless.
- **Every feature must justify its existence.** If it's not on the happy path (discovery → queue → benchmark → eval → forward), delete it. The codebase has been cleaned of Ollama, multi-VM orchestration, local ES, and SQLite precisely because they were not on the happy path.
- **Quality gate**: `npm run typecheck && npm run lint && npm run test` must all pass before any commit. Do not skip tests or suppress lint errors to pass.

## Learned User Preferences

- **Validate UI in browser**: After dashboard/layout changes, open the page and confirm visually — code-only edits are not sufficient.
- **Latest vLLM, no manual pins**: Deploy with `vllm/vllm-openai:latest` (auto-pulled); never require manual version bumps.
- **Maximize hardware utilization**: Tensor-parallel across all VM GPUs; use the largest feasible context (`--max-model-len auto` unless constrained).
- **Real data only**: Never manually seed ES or dashboard indices — all displayed results must come from actual benchmark runs.
- **Proactive 10x skills**: Evaluate and invoke 10x skills (shape, prd, plan) for multi-step features without waiting for the user to ask.
- **Avoid port 3100**: Run the built-in dashboard/API on **3200** (or another free port) — 3100 collides with patryks-treadmill.
- **No commit unless asked**: Do not commit, push, or put credentials in tracked files unless the user explicitly requests it.
- **Sanitize before push**: If real VM IPs, SSH paths, or tokens land in tracked files or commits, rewrite to placeholders (including git history) before pushing — never leave operator values on the remote.
- **One model at a time**: Never deploy or benchmark multiple models concurrently on the GPU VM — keep scheduler `maxConcurrentRuns` at 1.
- **Always benchmark the latest per family**: Before enqueuing/deploying any model, verify it's the newest release in its family via Hugging Face (`hub_repo_search` `sort:createdAt` / `hub_repo_details`) — never a stale generation (e.g. `Qwen2.5-Coder` is 2 gens behind `Qwen3-Coder-Next` as of 2026). Pick the newest generation that fits the hardware natively; if the flagship needs a quant the GPU can't run well (FP8 on Ampere/A100), pick the newest variant that fits bf16 and say so. See rule `prefer-latest-model-per-family`.
- **Customer-ready deploy commands**: Dashboard must expose one-click copy of the full vLLM/docker run command per model for customer handoff.
- **Finish only when green**: Keep validating and fixing until smoke tests and Buildkite evals pass — do not declare the pipeline done mid-run.
- **Real Kibana CI evals**: Stage 2 qualification must run against Buildkite on-demand security matrix suites, not local Kibana bootstrap.

## Learned Workspace Facts

- **Local dev ES**: Port **9223**; `docker compose --env-file .env.docker` with `ELASTIC_PASSWORD` and security enabled; `setup-local.sh` pulls 9.x DRA snapshot for `/_inference/_ccm` (Stage 3 EIS).
- **GPU VM profile**: Default hardware is `2xa100-80gb` (2× A100-80GB); operator SSH/VM values live in gitignored `config/local.json`. **The VM is ephemeral — never stop/suspend/delete/shutdown it; stopping = permanent loss** (Critical Project Rule 12 / `never-stop-benchmarker-gpu-vm` rule). `stop-local.sh` and `benchmarker-queue stop` only SIGTERM the local daemon, not the VM.
- **Golden cluster forwarding**: Only kbn/evals OTel traces reach golden ES via Buildkite — not via `GoldenForwarder`.
- **Dashboard/API server**: Built-in UI not started by daemon alone — run `npm run api` or use start flags; defaults port **3200**; recommendations table has expandable deployment rows with copy-command.
- **vLLM deploy defaults**: Docker image `vllm/vllm-openai:latest`; `tensor-parallel-size` = VM `gpuCount`; resolved pip version logged after deploy.
- **Model discovery**: `DiscoveryScheduler` polls HuggingFace and auto-queues hardware-fit candidates — no manual seeding. Three-tier supply: primary sort (`downloads`) → freshness fallback (`lastModified`) → size-targeted `fallbackSearchProbes` (default `['instruct', 'mistral small', 'mixtral']`). At the 24B floor the empty-search feed surfaces 0 fitting candidates, so the probe tier (verified live: `instruct` → Qwen 30–32B instruct, `mistral small` → Devstral/Mistral-Small 24B) is what actually keeps 24/7 supply flowing.
- **Discovery recency (focus on newest generation)**: three guards keep outdated generations out of benchmarking. (1) **Version-aware supersession** — `deriveModelGeneration` reads the numeric generation from the id (`Qwen2.5`→2.5, `Qwen3`→3, `Qwen3.6`→3.6); within a family a strictly-newer generation supersedes regardless of `createdAt` (a freshly-uploaded quant of an old base can't masquerade as newest). Date-gap (`SUPERSEDE_MIN_AGE_GAP_MS`, 30d) is the fallback only for generation-less names (`Mistral-Small`). Supersession is batch-local (only catches an old gen when a newer fitting sibling is in the same sweep). (2) **`excludeModelPatterns`** (discoveryScheduler config, case-insensitive regex, shared matcher in `src/utils/model-exclude.ts`) — hard denylist; default `['qwen2', 'qwen1', 'qwen3-', 'llama-2', 'llama2', 'codellama']`. **Current target generation is Qwen3.6** (Apr 2026, `qwen3_5_moe`), so all of Qwen3.0 is retired via `qwen3-`. **Mind the trailing dash**: `qwen3-` matches gen-3.0 ids (`qwen3-30b`, `qwen3-next-80b`, `qwen3-coder-*`) but NOT `qwen3.6-*` (dot, not dash, follows `qwen3`) — use bare `qwen2` (nukes 2.x) but dashed `qwen3-` (spares 3.6). (3) **Scheduler-side recency guard** (`retireIfRecencyExcluded`, runs at dequeue AND resume) — the denylist is a discovery-time backstop that can't touch an entry already in the queue (enqueued before the pattern was added, or force-enqueued then edited); the scheduler re-checks on every dequeue/resume and, for a matching entry without `metadata.force`, calls `queueService.cancelActive` → status `cancelled` (NOT `failed`, so it doesn't consume the daily cost cap). This is how an in-flight gen-3.0 model is stopped after a bounce. Note Qwen3.6 itself is a **multimodal** (`image-text-to-text`) model — it runs the text/tool-call security evals fine but discovery's text-generation filter won't re-surface it, so the current-gen target is benchmarked via manual `benchmark-model` enqueue, not auto-discovery.
- **CI eval platform**: On-demand Buildkite only (no weekly trigger; `triggerFullEval` deprecated). Three security suites run **sequentially** (one build each): `security-alert-triage`, `security-alerts-rag-regression`, `security-esql-generation-regression`. Flow: SSH tunnel → ngrok → pipeline `kibana-evals-on-demand-llm-evals` with `KIBANA_TESTING_AI_CONNECTORS` (`.gen-ai`, `apiProvider: Other`). Default gates: `adoptRunningBuild` + `waitForPipelineIdle`; `detachPoll: true`; `pollTimeoutMs` **3h**.
- **Stage 2 ITL gate**: `stage2Thresholds.maxItlP50Ms` (default 20ms) — not `maxTtftMs`.
- **Stage 3 EIS reasoning**: `EisLlmClient` when `EIS_CCM_API_KEY` set; calls `/_inference/chat_completion/<id>/_stream`; maps `eis/<model>` → `.<model>-chat_completion`. Hermes is not an LLM proxy.
- **Graceful daemon stop**: `./scripts/stop-local.sh` or `benchmarker-queue stop` (SIGTERM) — never `pkill` during CI eval polling.
- **Operator daemon start**: `./scripts/start-local.sh [--daemonize]` sources `.env` + `.env.docker` + Buildkite token; passes absolute `--config` to `config/local.json`; enables `--ci-evals` by default.
- **Smoke tests & pipeline doc**: `npm run smoke:stage3` (EIS → Stage 3 → ES); `npm run smoke:full` (discovery → Stage 1 → CI evals + tunnel → Stage 3 → dashboard). Visual reference: `docs/pipeline-how-it-works.html`.
