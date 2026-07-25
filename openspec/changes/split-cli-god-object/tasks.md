# Tasks: Split CLI God Object

## Phase 1 — Extract Daemon class [P0]

- [ ] Create `src/cli/daemon-lifecycle.ts` with `Daemon` class
  - Constructor accepts a `DaemonDeps` interface (config, scheduler, sshPool, esClient, resultsStore, gpuVmLease, lockfile, discoveryScheduler, maintenanceScheduler, leaseHeartbeat)
  - `start()` method runs the poll loop (extracted from the `start` action)
  - `async shutdown(signal)` method owns the full cleanup sequence
  - No `process.exit()` inside the class
  - Verify: `npx tsc --noEmit` — 0 errors

- [ ] Create `src/cli/shared.ts` with shared helpers
  - `resolveConfigPath(argv: string[]): string` — robust --config resolution
  - `createEsClient(config): Client` — ES client factory
  - `createSshPool(config): SSHClientPool` — SSH pool factory
  - Verify: `npx tsc --noEmit` — 0 errors

## Phase 2 — Extract command handlers [P0]

- [ ] Create `src/cli/start-handler.ts`
  - Move the ~600-line `start` action into `createStartHandler()`
  - Instantiate `Daemon` and wire signal handlers
  - Replace inline `process.exit()` with thrown `CliError`
  - Verify: `npx tsc --noEmit` — 0 errors, `npm test` — 1168 passing

- [ ] Create `src/cli/results-handler.ts`
  - Move the `results` command into `createResultsHandler()`
  - Uses `getAllModelSummaries()` batch method
  - Verify: `npx tsc --noEmit` — 0 errors

- [ ] Create `src/cli/index.ts`
  - `createProgram()` wires all commands via commander
  - <100 lines
  - Verify: `npx tsc --noEmit` — 0 errors

- [ ] Make `src/cli.ts` a thin re-export shim
  - `export { createProgram } from './cli/index.js';`
  - Verify: `npx tsc --noEmit` — 0 errors

## Phase 3 — Tests [P1]

- [ ] Add `tests/unit/daemon-lifecycle.test.ts`
  - Test `Daemon.shutdown()` calls close() on all deps in correct order
  - Test shutdown is idempotent (safe to call twice)
  - Verify: `npm test` — new tests passing

- [ ] Add `tests/unit/cli-start-handler.test.ts`
  - Test CliError is thrown instead of process.exit
  - Verify: `npm test` — new tests passing

## Phase 4 — Deploy [P2]

- [ ] Full test suite: `npm test` — all passing
- [ ] Build: `npm run build` — success
- [ ] Deploy to i9: git pull + build + bounce worker
- [ ] Watchdog: confirm worker healthy for 5 minutes
