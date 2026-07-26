## ADDED Requirements

### Requirement: Controlled Process Exit

The system SHALL route all process termination through a single controlled shutdown function that cleans up acquired resources before exiting.

#### Scenario: Handler error exit

- WHEN a command handler encounters a fatal error
- THEN it SHALL throw a `CliError` with an exit code
- AND the top-level catch SHALL log the error and call `process.exit(exitCode)`
- AND any acquired resources SHALL be cleaned up before exit

#### Scenario: Signal-driven shutdown

- WHEN the daemon receives SIGINT or SIGTERM
- THEN the graceful shutdown sequence SHALL run to completion
- AND SHALL clear intervals, stop schedulers, close SSH pools, release leases, release lockfiles, close ES clients
- AND SHALL call `process.exit(0)` only after all cleanup completes

### Requirement: CLI Handler Module Separation

The system SHALL extract command handler bodies into focused modules under src/cli/.

#### Scenario: Handler delegation

- WHEN a command is registered on the program
- THEN its action handler SHALL delegate to an imported function from src/cli/
- AND cli.ts SHALL contain only command definitions, option wiring, and one-line action calls

### Requirement: Structured Service Returns

Public service methods that can fail SHALL return `ServiceResult<T>` instead of throwing errors.

#### Scenario: Caller handles failure

- WHEN a public service method encounters an error
- THEN it SHALL return `{ success: false, error: string, code?: string }`
- AND the caller SHALL check `result.success` before using `result.data`
