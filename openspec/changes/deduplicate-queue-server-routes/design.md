# Design: Deduplicate Queue Server Routes

## Affected Routes

| Route | v1 (line) | main (line) | Difference |
|---|---|---|---|
| DELETE /queue/:id | 434 | 785 | None — identical |
| GET /queue/events (SSE) | 457 | 806 | v1 lacks `enrichQueueEntryProgress()` |

## Extraction Plan

### 1. DELETE handler
```typescript
function makeDeleteEntryHandler(queueService: QueueService) {
  return async (req: Request, res: Response) => {
    // single implementation
  };
}
```

### 2. SSE handler
```typescript
function makeEventHandler(queueService: QueueService, opts: { enrich: boolean }) {
  return async (req: Request, res: Response) => {
    // single implementation, always enriches
  };
}
```

Both v1 and main routes use the same factory. The `enrich` flag is removed — all SSE streams enrich progress identically.
