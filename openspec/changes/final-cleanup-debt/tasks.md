# Tasks: Final Cleanup Debt

## Phase A — Controlled Shutdown
- [ ] Create `src/cli/shutdown.ts` with `CliError` class and `gracefulShutdown()` function
- [ ] Replace `process.exit()` calls in cli.ts with `throw new CliError()`
- [ ] Replace `process.exit()` calls in start-handler.ts shutdown closure with `gracefulShutdown()`
- [ ] Add top-level catch in cli.ts that handles CliError
- [ ] Verify: tsc clean, 1168 tests pass

## Phase B — CLI Handler Extraction
- [ ] Extract `results` handler → `src/cli/results-handler.ts`
- [ ] Extract `regenerate-recommendation` handler → `src/cli/regenerate-handler.ts`
- [ ] Extract `recommend` handler → `src/cli/recommend-handler.ts`
- [ ] Extract `report` handler → `src/cli/report-handler.ts`
- [ ] Verify: cli.ts under 1000 lines, tsc clean, tests pass

## Phase C — ServiceResult Conversions
- [ ] Convert `ssh-client.ts` public methods (8 throws)
- [ ] Convert `github-publisher.ts` publish() (4 throws)
- [ ] Convert `health-check.ts` checkAll() (3 throws)
- [ ] Convert `kibana-repo-service.ts` cloneOrPull/bootstrap (3 throws)
- [ ] Update callers in scheduler.ts and cli.ts
- [ ] Update tests for new return types
- [ ] Verify: tsc clean, 1168 tests pass

## Deploy
- [ ] Commit all changes
- [ ] Push to origin
- [ ] Sync to i9, rebuild, bounce daemon
- [ ] Run watchdog — verify worker, api, vm all green
