# cli-architecture Specification

## Purpose
TBD - created by archiving change split-cli-god-object. Update Purpose after archive.
## Requirements
### Requirement: CLI Module Decomposition

The CLI entry point SHALL be decomposed into focused modules under `src/cli/` with each command handler as a testable function. No command handler SHALL call `process.exit()` directly.

#### Scenario: Start command is extracted
- **WHEN** the codebase is refactored
- **THEN** `src/cli/start-handler.ts` MUST contain the start command action handler
- **AND** the handler MUST be a pure function accepting dependencies
- **AND** no inline `process.exit()` calls SHALL exist in the handler

#### Scenario: Daemon class owns lifecycle
- **WHEN** a signal is received (SIGINT/SIGTERM)
- **THEN** `Daemon.shutdown()` MUST be called
- **AND** cleanup SHALL run in order: scheduler → sshPool → lease → lockfile → store → esClient
- **AND** `process.exit()` MUST be called exactly once after cleanup completes

#### Scenario: CLI re-export shim preserves backward compat
- **WHEN** `src/cli.ts` is imported
- **THEN** it SHALL re-export `createProgram` from `src/cli/index.ts`
- **AND** no runtime behavior SHALL change

