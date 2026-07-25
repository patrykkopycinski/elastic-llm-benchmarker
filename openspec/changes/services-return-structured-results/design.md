# Design: Services Return Structured Results

## Result Type

```typescript
// src/types/service-result.ts
export type ServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string };

// Helpers
export function ok<T>(data: T): ServiceResult<T> {
  return { success: true, data };
}

export function fail<T = never>(error: string, code?: string): ServiceResult<T> {
  return { success: false, error, code };
}

export function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}
```

## Conversion Pattern

### Before
```typescript
async complete(opts: LlmCompleteOptions): Promise<string> {
  if (!this.config.llmApiKey) throw new Error('API key missing');
  // ...
  throw new Error('API error: ' + resp.status);
  // ...
  return content;
}
```

### After
```typescript
async complete(opts: LlmCompleteOptions): Promise<ServiceResult<string>> {
  if (!this.config.llmApiKey) return fail('API key missing', 'NO_API_KEY');
  // ...
  if (!resp.ok) return fail(`API error: ${resp.status}`, 'API_ERROR');
  // ...
  return ok(content);
}
```

## Caller Update Pattern

### Before
```typescript
try {
  const content = await llmClient.complete(opts);
  // use content
} catch (err) {
  logger.error('LLM failed', { error: err.message });
}
```

### After
```typescript
const result = await llmClient.complete(opts);
if (!result.success) {
  logger.error('LLM failed', { error: result.error, code: result.code });
  return;
}
const content = result.data;
```

## Migration Order

1. `src/types/service-result.ts` — new file
2. `llm-client.ts` + `tests/unit/llm-client.test.ts` — simplest (3 throws, 1 caller)
3. `hardware-profiles.ts` — trivial (1 throw)
4. `buildkite-eval-trigger.ts` + tests — medium (6 throws, 1 caller)
5. `eis-llm-client.ts` + tests — largest (8 throws, 2 callers)
6. `tunnel-service.ts` + tests — most complex (9 throws, 2 callers)

Each step must pass full test suite before moving to the next.
