# Tasks: Final Cleanup Debt — COMPLETE

## Phase A — Controlled Shutdown ✅
- [x] Create `src/cli/shutdown.ts` with `CliError` class and `gracefulShutdown()` function
- [x] Replace `process.exit()` calls in start-handler.ts with `throw new CliError()` (10 sites)
- [x] Replace daemon shutdown closure with `gracefulShutdown()` call
- [x] Add global `unhandledRejection` handler in cli.ts for uniform CliError handling
- [x] Verify: tsc clean, 1168 tests pass

Scope note: only the daemon (`start` command) holds long-lived resources worth
a controlled shutdown path. One-shot CLI commands exit before resources are
meaningfully held — left as `process.exit()`.

## Phase B — CLI Handler Extraction ✅
- [x] Extract `results` handler → `src/cli/results-handler.ts` (120 lines)
- [x] Extract `recommend` handler → `src/cli/recommend-handler.ts` (53 lines)
- [x] Extract `regenerate-recommendation` handler → `src/cli/regenerate-handler.ts` (180 lines)
- [x] Extract shared `output`/`outputError`/`formatDuration` → `src/cli/output.ts`
- [x] Extract shared `printReport`/`printReportSummary` → `src/cli/report-printer.ts`
- [x] Verify: cli.ts 2233 → 1190 lines (47% reduction), tsc clean, tests pass

## Phase C — ServiceResult Conversions ✅ (scoped)
- [x] Convert `github-publisher.ts` publish() to ServiceResult
- [x] Convert `kibana-repo-service.ts` cloneOrPull()/bootstrap() to ServiceResult
- [x] Update callers (cli.ts bootstrap-kibana, stage2-worker.ts)
- [x] Update tests for new return types
- [x] Verify: tsc clean, 1168 tests pass

Decision: skipped `ssh-client.ts` (26 call sites across 7 files, already has
typed SSHError subclasses — conversion would be invasive with no behavioral
gain) and `health-check.ts` (HealthCheckServiceError is deliberately caught
via `instanceof` in error-recovery.ts's classifyHealthCheckError() —
converting would regress that discrimination logic). Converting these would
be busywork, not improvement — matches the plan's stated decision criteria.

## Deploy ✅
- [x] Commit all changes (3 commits: c7baccd, 57ed861, 3b0cd04, 7efc9cb)
- [x] Push to origin
- [x] Sync to i9, rebuild, bounce daemon
- [x] Run watchdog — worker, api, vm all green
