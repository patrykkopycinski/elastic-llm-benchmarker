# service-result-contract Specification

## Purpose
TBD - created by archiving change services-return-structured-results. Update Purpose after archive.
## Requirements
### Requirement: ServiceResult Return Type

All public methods in `src/services/` SHALL return `Promise<ServiceResult<T>>` instead of throwing errors. Service methods MUST NOT use `throw new Error()`.

#### Scenario: Service method returns structured result
- **WHEN** a service method encounters an error
- **THEN** it SHALL return `{ success: false, error: string, code?: string }`
- **AND** no exception SHALL propagate to the caller

#### Scenario: Success path returns data
- **WHEN** a service method succeeds
- **THEN** it SHALL return `{ success: true, data: T }`

#### Scenario: No throw statements in services
- **WHEN** the codebase is scanned
- **THEN** zero `throw new Error()` calls SHALL exist in `src/services/`
- **AND** all error paths MUST use `return fail()`

