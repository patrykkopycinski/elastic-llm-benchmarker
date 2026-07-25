# Tasks: Services Return Structured Results

## Phase 1 — Foundation [P0]

- [ ] Create `src/types/service-result.ts`
  - Define `ServiceResult<T>`, `ok()`, `fail()`, `unwrap()`
  - Verify: `npx tsc --noEmit` — 0 errors

- [ ] Convert `llm-client.ts` (3 throws)
  - Change return types to `ServiceResult<T>`
  - Replace throws with `fail()`
  - Update `stage3-worker.ts` caller
  - Update `tests/unit/llm-client.test.ts`
  - Verify: `npx tsc --noEmit` — 0 errors, `npm test` — all passing

## Phase 2 — Simple services [P1]

- [ ] Convert `hardware-profiles.ts` (1 throw)
  - Verify: `npx tsc --noEmit` clean, `npm test` passing

- [ ] Convert `buildkite-eval-trigger.ts` (6 throws)
  - Update `scheduler.ts` caller
  - Update tests
  - Verify: `npx tsc --noEmit` clean, `npm test` passing

## Phase 3 — Complex services [P1]

- [ ] Convert `eis-llm-client.ts` (8 throws)
  - Update `stage3-worker.ts` and `scheduler.ts` callers
  - Update tests
  - Verify: `npx tsc --noEmit` clean, `npm test` passing

- [ ] Convert `tunnel-service.ts` (9 throws)
  - Update `scheduler.ts` and `ci-eval-infrastructure-guard.ts` callers
  - Update tests
  - Verify: `npx tsc --noEmit` clean, `npm test` passing

## Phase 4 — Deploy [P2]

- [ ] Full test suite passing
- [ ] Build success
- [ ] Deploy to i9 + bounce
- [ ] Watchdog healthy for 5 min
