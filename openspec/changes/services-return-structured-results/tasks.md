# Tasks: Services Return Structured Results

## Phase 1 — Foundation [P0] ✅

- [x] Create `src/types/service-result.ts`
  - Defined `ServiceResult<T>`, `ok()`, `fail()`, `unwrap()`

- [x] Convert `llm-client.ts` (3 throws)
  - Changed return types to `ServiceResult<T>`
  - Replaced throws with `fail()`
  - Updated `stage3-worker.ts` caller
  - Updated `tests/unit/llm-client.test.ts`

## Phase 2 — Simple services [P1] ✅

- [x] Convert `hardware-profiles.ts` (1 throw)

## Phase 3 — Complex services [P1] — PARTIAL

- [x] Convert `eis-llm-client.ts` complete() (8 throws → wrapped in try-catch)
  - Updated `stage3-worker.ts` and tests
  - Internal helpers still throw (acceptable — they're private implementation details)

- [ ] Convert `buildkite-eval-trigger.ts` (6 throws) — **Deferred: dedicated PR**
  - 616 lines, 1 caller (scheduler.ts), needs careful migration

- [ ] Convert `tunnel-service.ts` (9 throws) — **Deferred: dedicated PR**
  - 1405 lines, 2 callers, most complex surface area

## Phase 4 — Deploy [P2] ✅

- [x] Full test suite passing (1168/1168)
- [x] Build success
- [x] Deploy to i9 + bounce
- [x] Watchdog healthy
