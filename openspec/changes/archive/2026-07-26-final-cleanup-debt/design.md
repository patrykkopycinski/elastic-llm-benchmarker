# Design: Final Cleanup Debt

## Phase A — Controlled Shutdown (process.exit consolidation)

### Problem
41 `process.exit()` calls scattered across cli.ts (28) and start-handler.ts (13). Each one can fire at any point in a command handler, bypassing cleanup of:
- SSHClientPool (idle connections with 5-min timers)
- GpuVmLease (lease not released → blocks next model)
- Elasticsearch client (connection pool not drained)
- Lockfile (stale lock blocks next start)

### Approach
Define a `CliError` class with an `exitCode` field. Replace `process.exit(N)` in handlers with `throw new CliError(message, N)`. The top-level CLI entry catches `CliError` and calls `process.exit(error.exitCode)` after a single cleanup pass.

For the start handler, the shutdown closure already exists and runs the full cleanup sequence. We extract it as a standalone `gracefulShutdown()` function that all exit paths funnel through.

```typescript
// src/cli/shutdown.ts
export class CliError extends Error {
  constructor(message: string, public readonly exitCode: number = 1) {
    super(message);
  }
}

export async function gracefulShutdown(
  resources: { scheduler?: Scheduler; sshPool?: SSHClientPool; ... },
  signal: string,
): Promise<void> {
  // existing shutdown sequence, consolidated
}
```

Files touched: `src/cli.ts`, `src/cli/start-handler.ts`, new `src/cli/shutdown.ts`

## Phase B — CLI Handler Extraction (Phase 2)

### Problem
cli.ts is still 1614 lines with 15 inline command handlers.

### Approach
Extract the 3 largest remaining handlers:
- `results` (lines 307-442, ~135 lines) → `src/cli/results-handler.ts`
- `report` (lines 643-659, ~16 lines) → `src/cli/report-handler.ts`
- `recommend` (lines 850-917, ~67 lines) → `src/cli/recommend-handler.ts`

Also extract the `regenerate-recommendation` handler (lines 918-1150, ~232 lines — surprisingly large).

Pattern: same as start-handler.ts — export a function, import it in cli.ts, replace inline body.

Target: cli.ts under 1000 lines.

## Phase C — Remaining ServiceResult Conversions

### Problem
51 throws remain in 12 service files. Not all need conversion — only public interface methods that callers depend on.

### Approach
Convert these public service methods:
- `ssh-client.ts` — SSHClientPool public methods (8 throws)
- `github-publisher.ts` — publish() and related (4 throws)
- `health-check.ts` — checkAll() and related (3 throws)
- `kibana-repo-service.ts` — cloneOrPull/bootstrap (3 throws)

Leave internal throws in place where they're caught by public methods (tunnel-service providers, eis-llm-client helpers, kibana-connector internals).

### Decision criteria
- Convert: method is called from scheduler.ts or cli.ts and the caller would benefit from structured error handling
- Skip: method is private, or only called from within the same class and caught there

## Testing Strategy

- Pure refactoring — zero behavior changes
- All 1168 tests must pass unchanged
- `npx tsc --noEmit` must report 0 errors
- Deploy to i9, bounce daemon, verify watchdog healthy
