# Proposal: Final Cleanup Debt

## Summary

Consolidate 41 scattered `process.exit()` calls into a controlled shutdown path, extract remaining inline CLI command handlers into modules, and convert remaining service throws to `ServiceResult<T>` structured returns.

## Motivation

The benchmarker codebase has been hardened across 20 commits fixing 10 bugs and 13 audit findings. Three OpenSpec changes (route dedup, ServiceResult Phase 1, CLI Phase 1) are archived. This change closes the remaining debt:

- **41 `process.exit()` calls** across cli.ts and start-handler.ts bypass resource cleanup (SSH pool, GPU lease, ES client, lockfile). On crash or error paths, acquired resources leak — SSH connections linger with 5-min idle timers, GPU leases aren't released, lockfiles aren't cleared.
- **15 inline command handlers** remain in cli.ts (1614 lines). The `results`, `report`, and `recommend` handlers are each 100-150 lines.
- **51 throws** remain in service files. Public methods that callers depend on should return `ServiceResult<T>` rather than throwing, matching the pattern already established in llm-client, eis-llm-client, buildkite-eval-trigger, and hardware-profiles.

## Requirements

- The system SHALL consolidate `process.exit()` calls into a single controlled shutdown function that the CLI calls after cleanup.
- The system SHALL NOT call `process.exit()` from inside service or handler code — only from the top-level CLI entry point.
- The system SHALL extract remaining inline command handlers from cli.ts into focused modules under src/cli/.
- The system SHALL convert public service methods that currently throw errors to return `ServiceResult<T>`.
- All existing tests MUST continue to pass with zero behavioral changes.
