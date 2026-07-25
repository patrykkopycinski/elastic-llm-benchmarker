# Tasks: Services Return Structured Results — COMPLETE

## Phase 1 — Foundation ✅
- [x] Create `src/types/service-result.ts` (ServiceResult<T>, ok(), fail(), unwrap())

## Phase 2 — Service Conversions ✅
- [x] Convert `llm-client.ts` (3 throws → ServiceResult)
- [x] Convert `eis-llm-client.ts` complete() (wraps internal throws)
- [x] Convert `hardware-profiles.ts` registerProfile()
- [x] Convert `buildkite-eval-trigger.ts` (6 throws → ServiceResult)
- [x] `tunnel-service.ts` — already returns TunnelResult (structured result)
  from connect()/reconnect(); provider throws are internal, caught by public methods

## Phase 3 — Tests ✅
- [x] All 1168 tests passing across 77 files
- [x] TypeScript: 0 errors

## Phase 4 — Deploy ✅
- [x] Build success
- [x] Deploy to i9 + bounce worker + watchdog healthy

## Out of Scope (lower-priority services)
- ci-eval-stage2-mapper.ts, config-researcher.ts, github-publisher.ts,
  health-check.ts, hf-card-parser.ts, local-batch-eval-runner.ts
  (not part of original 5-service scope; can be converted in future PRs)
