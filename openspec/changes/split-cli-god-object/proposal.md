# Proposal: Split CLI God Object

## Summary

`src/cli.ts` is a 2,233-line god object with ~50 `process.exit()` calls and a ~600-line `start` command handler. Extract it into focused modules under `src/cli/` following the existing `enqueue-handler.ts` pattern.

## Motivation

The single-file CLI design is the #1 maintainability risk in the codebase:

- **50 `process.exit()` calls** bypass cleanup for already-acquired resources (SSH pools, ES clients, leases, tunnels)
- **600-line `start` handler** wires every service, manages lease acquisition, shutdown, discovery, CI evals — all in one function
- **No test coverage** of the CLI layer — the size makes it untestable
- **Merge conflicts** on every change (every PR touches cli.ts)

## Design

Extract into `src/cli/` modules:

```
src/cli/
  index.ts              # re-exports createProgram()
  start-handler.ts      # the start command action (~400 lines)
  daemon-lifecycle.ts   # Daemon class: owns all service refs + shutdown sequence
  results-handler.ts    # the results command action
  queue-handler.ts      # existing (already extracted)
  shared.ts             # resolveConfig(), createEsClient(), createSshPool()
```

**Daemon class** (`daemon-lifecycle.ts`):
- Constructor takes a config + all service instances
- `start()` method runs the poll loop
- `shutdown()` method owns the full cleanup sequence (SSH pool, ES client, lease, lockfile, scheduler)
- No `process.exit()` inside the class — callers exit after `await daemon.shutdown()`

## Non-goals

- Rewriting the command structure or adding new commands
- Changing any runtime behavior (this is a pure refactor)
- Splitting other large files (tunnel-service, scheduler — separate changes)

## Tasks

### [P0] Extract Daemon lifecycle class — `src/cli/daemon-lifecycle.ts`
- Create `Daemon` class that takes `{ config, scheduler, sshPool, esClient, resultsStore, gpuVmLease, lockfile, discoveryScheduler, maintenanceScheduler, leaseHeartbeat }`
- `start()` runs the poll loop, `shutdown(signal)` owns cleanup
- Move all 3 `process.exit()` calls out of the class — the signal handler in start-handler calls `daemon.shutdown()` then exits
- **Verify**: `npx tsc --noEmit` clean, `npm test` 1168/1168 passing

### [P0] Extract start command handler — `src/cli/start-handler.ts`
- Move the ~600-line `start` action into `createStartHandler()`
- Replace inline `process.exit()` calls with thrown `CliError` caught by the top-level handler
- Import `Daemon` from daemon-lifecycle.ts
- **Verify**: `npx tsc --noEmit` clean, `npm test` passing, manual `benchmarker-queue start` smoke

### [P1] Extract results handler — `src/cli/results-handler.ts`
- Move the `results` command action into `createResultsHandler()`
- Uses the new `getAllModelSummaries()` batch method
- **Verify**: `npx tsc --noEmit` clean, `npm test` passing

### [P1] Extract shared helpers — `src/cli/shared.ts`
- `resolveConfig()`, `createEsClient()`, `createSshPool()` used by multiple handlers
- **Verify**: `npx tsc --noEmit` clean

### [P2] Add CLI integration tests — `tests/integration/cli.test.ts`
- Test `--help` for each command
- Test `results --summary --json` output shape
- Test `results --model <id>` single-model path
- **Verify**: `npm test` includes new tests passing
