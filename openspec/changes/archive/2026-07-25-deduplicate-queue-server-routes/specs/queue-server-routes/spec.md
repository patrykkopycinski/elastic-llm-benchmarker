## ADDED Requirements

### Requirement: Route Handler Deduplication

Queue server route handlers SHALL not be duplicated between `/api` and `/api/v1` namespaces. Shared handler factory functions MUST be used.

#### Scenario: DELETE route uses shared handler
- **WHEN** `DELETE /api/queue/:id` or `DELETE /api/v1/queue/:id` is called
- **THEN** both SHALL invoke the same handler factory function
- **AND** identical behavior MUST be guaranteed

#### Scenario: SSE route enriches progress on both paths
- **WHEN** `GET /api/queue/events` or `GET /api/v1/queue/events` is called
- **THEN** both SHALL invoke the same handler factory
- **AND** both MUST apply `enrichQueueEntryProgress()` identically
