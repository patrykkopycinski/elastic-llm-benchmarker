# Tasks: Deduplicate Queue Server Routes

- [ ] Extract shared DELETE handler
  - Create `makeDeleteEntryHandler(queueService)` factory
  - Wire to both `app.delete('/api/queue/:id')` and `v1Router.delete('/queue/:id')`
  - Verify: `npx tsc --noEmit` clean, `npm test` passing

- [ ] Extract shared SSE handler
  - Create `makeQueueEventHandler(queueService)` factory
  - Always calls `enrichQueueEntryProgress()` (fixes v1 inconsistency)
  - Wire to both `/api/queue/events` and `/api/v1/queue/events`
  - Verify: `npx tsc --noEmit` clean, `npm test` passing

- [ ] Add regression test for SSE enrichment parity
  - Test both v1 and main SSE endpoints return enriched progress
  - Verify: `npm test` — new test passing
