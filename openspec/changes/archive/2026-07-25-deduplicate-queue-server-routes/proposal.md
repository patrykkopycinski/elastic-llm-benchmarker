# Proposal: Deduplicate Queue Server Routes

## Summary

`src/api/queue-server.ts` has duplicate route definitions for `DELETE /api/queue/:id` and SSE `/api/queue/events` — once under `/api/v1` and once under `/api` with slightly different implementations. Extract shared handlers to eliminate the duplication.

## Motivation

- **DELETE route** (lines 434-454 vs 785-804): identical logic, copy-pasted
- **SSE events route** (lines 457-482 vs 806-834): near-identical, but the v1 version doesn't call `enrichQueueEntryProgress()` — a behavioral inconsistency
- Maintenance burden: bug fixes must be applied in two places

## Design

Extract shared handler functions:

```typescript
// Before:
app.delete('/api/queue/:id', async (req, res) => { /* 20 lines */ });
v1Router.delete('/queue/:id', async (req, res) => { /* 20 lines (identical) */ });

// After:
async function handleDeleteEntry(req, res, queueService) { /* single implementation */ }
app.delete('/api/queue/:id', (req, res) => handleDeleteEntry(req, res, queueService));
v1Router.delete('/queue/:id', (req, res) => handleDeleteEntry(req, res, queueService));
```

For SSE: consolidate the event subscription logic into a single `createEventStream()` that always applies `enrichQueueEntryProgress()` (fixing the inconsistency).

## Non-goals

- Removing the `/api/v1` namespace (it's a versioning contract)
- Refactoring the entire API server
- Adding new endpoints
