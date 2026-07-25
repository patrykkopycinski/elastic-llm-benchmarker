# Design: Split CLI God Object

## Current State

`src/cli.ts` (2,233 lines) contains:
- `createProgram()` — the main entry point that wires all `commander` commands
- `start` command action handler (~600 lines, lines 1445–1979) — instantiates every service, acquires lease, starts scheduler, sets up signal handlers, runs poll loop
- `results` command action handler (~100 lines) — fetches benchmark summaries from ES
- `queue` command action handler (~30 lines, already extracted to `enqueue-handler.ts`)
- 50 `process.exit()` calls scattered throughout
- Manual argv parsing (`resolveStartConfigPath` at line 100)

## Target State

```
src/cli/
  index.ts              # createProgram() — wires commands, <100 lines
  start-handler.ts      # createStartHandler(deps) — configures services, starts Daemon
  daemon-lifecycle.ts   # Daemon class — owns runtime refs + shutdown
  results-handler.ts    # createResultsHandler(deps) — results/summary commands
  shared.ts             # resolveConfig(), createEsClient(), createSshPool(), resolveLockfile()
```

`src/cli.ts` becomes a thin re-export shim (<20 lines) for backward compat.

## Key Decisions

### 1. Daemon class owns shutdown, not the handler
The current code has cleanup logic inline in the `start` action's `shutdown()` closure. This means:
- Signal handlers capture 15+ closure variables
- `process.exit()` is called inside the closure, bypassing any pending async work

**New approach**: `Daemon` class with `async shutdown()`:
```typescript
class Daemon {
  // holds refs to scheduler, sshPool, esClient, resultsStore, lease, lockfile, etc.
  async start(): Promise<void> { /* poll loop */ }
  async shutdown(signal: string): Promise<void> {
    // ordered cleanup: scheduler → sshPool → lease → lockfile → store → esClient
    // NO process.exit() — caller handles that
  }
}
```

### 2. process.exit() replaced with CliError
Instead of `process.exit(1)`, throw `new CliError(message, { exitCode: 1 })`. The top-level handler in `index.ts` catches it, logs, and exits once. This ensures async cleanup completes.

### 3. No behavior changes
This is a pure refactor. Every runtime path must produce identical behavior. The only acceptable diff is file structure.

## Constraints

- **Backward compat**: `src/cli.ts` must still export `createProgram()` (other entry points import it)
- **Test isolation**: new modules must be importable in isolation for unit testing
- **No new deps**: use existing `commander` patterns only
