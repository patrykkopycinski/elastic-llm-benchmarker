# `elastic-llm-benchmarker` — Agent Onboarding

## Project Overview

Autonomous LLM benchmarking pipeline. Discovers models from HuggingFace, runs vLLM benchmarks on GPU VMs via SSH, evaluates with Kibana's own eval suites, stores everything in Elasticsearch, and publishes curated results to a shared golden cluster.

**Architecture**: TypeScript daemon, Elastic Serverless as single source of truth, REST API for CI/dashboards, async golden forwarding.

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
npm run start -- --config config.yaml --stage2 --stage3 --api-port 3000
```

## Critical Project Rules

1. **Unified persistence**: Elastic Serverless is the primary store. No SQLite. No local ES instance. All data (queue, results, traces, DLQ, model history) lives in the serverless cluster.
2. **Forward-only shared cluster**: The shared/golden ES cluster is write-only. We forward eval traces and public benchmark cards; we never read from it.
3. **Never throw in services**: All service methods return structured results with `.success`, `.error`, `.data`. Internal errors are logged and returned, never thrown.
4. **Queue API surface**: Services talk to each other via `QueueService` with exactly four methods: `enqueue()`, `claim()`, `complete()`, `fail()`. No `add()` or `initialize()`.
5. **SSH as black box**: The GPU VM is reached only via `SSHClientPool` in `src/services/ssh-client.ts`. No direct SSH calls outside this service.
6. **OTel field casing**: In ES trace indices, fields are PascalCase: `TraceId`, `SpanId`, `ParentSpanId`, `Attributes`, `Duration`, `Name`. ES|QL queries must match this exactly.
7. **Stage 2 runs only on Stage 1 pass**: `stage2_thresholds` gate must be met before Kibana eval suites execute.
8. **Golden forwarder is async background work**: Batches of 100 docs max, 5 min flush interval. On 429: drop-last + retry. On 5xx: exponential backoff then DLQ.
9. **API keys are SHA-256 hashed**: Never store plaintext API keys in ES. Use `crypto.createHash('sha256').update(key).digest('hex')` for comparison.
10. **No orphaned services**: If a service is not referenced on the happy path (start → scheduler → worker → store → forwarder), delete it. Do not keep dead code.

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
    golden-forwarder.ts              # Async replication to shared ES
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
| Golden forwarder queue growing | Check `benchmarker-errors` index for failure reasons. Likely 429 or 503 from shared ES. |
| Type errors in tests | Check that mocks match new service signatures. Update `__mocks__/` if needed. |

## Security Rules

1. **Never commit credentials**: SSH passwords, private keys, API tokens, and `.env` files must never be committed. Use `.env.example` for documentation only.
2. **Never log secrets**: Winston loggers must redact sensitive fields (`password`, `apiKey`, `token`, `privateKey`). Use a structured log serializer.
3. **Config schemas expose field shapes, not values**: The Zod schema for `ssh.password` and `ssh.privateKeyPath` documents what the app accepts — never put real values in committed config files.
4. **API key hashing**: When storing or comparing API keys, always hash with SHA-256. Never store plaintext in Elasticsearch or config files.
5. **Golden cluster is write-only**: Read access is prohibited. This prevents accidental leakage of shared eval data back into local contexts.

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
