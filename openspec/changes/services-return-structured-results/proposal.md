# Proposal: Services Return Structured Results Instead of Throwing

## Summary

Convert 36 `throw new Error()` calls across 5 service files to return `{ success: boolean, error?: string, data?: T }` structured results per the AGENTS.md architecture contract.

## Motivation

AGENTS.md states: "Never throw in services — return structured results." Despite this rule, 36 throw sites exist:

- `llm-client.ts` — 3 throws (API key missing, API error, invalid JSON)
- `eis-llm-client.ts` — 8 throws (stream errors, CCM failures)
- `buildkite-eval-trigger.ts` — 6 throws (invalid options, branch guard, build creation)
- `tunnel-service.ts` — 9 throws (tunnel creation failure across 4 providers)
- `hardware-profiles.ts` — 1 throw (empty profile ID)

The workers that call these services already wrap them in try-catch, so callers are safe — but the pattern is inconsistent with the stated architecture and makes error handling non-ergonomic.

## Design

### Result type

```typescript
export type ServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string };
```

### Migration strategy

Per-file, bottom-up:
1. Define `ServiceResult<T>` in `src/types/service-result.ts`
2. Convert each service method signature from `Promise<T>` to `Promise<ServiceResult<T>>`
3. Replace `throw new Error(msg)` with `return { success: false, error: msg }`
4. Update all callers to destructure `{ success, data, error }` instead of try-catch
5. Update tests to check `result.success` instead of `expect(fn).rejects.toThrow()`

### Files affected

| File | Throws | Callers to update |
|---|---|---|
| `llm-client.ts` | 3 | stage3-worker, tests |
| `eis-llm-client.ts` | 8 | stage3-worker, scheduler, tests |
| `buildkite-eval-trigger.ts` | 6 | scheduler, tests |
| `tunnel-service.ts` | 9 | scheduler, ci-eval-guard, tests |
| `hardware-profiles.ts` | 1 | scheduler |

## Non-goals

- Converting non-service files (CLI, API server) — those can throw
- Changing the ServiceResult type shape (keep it simple)
- Adding retry logic inside services
