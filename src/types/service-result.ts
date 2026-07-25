/**
 * Structured result type for service methods.
 * Services must never throw — they return ServiceResult instead.
 */
export type ServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string };

/** Create a success result. */
export function ok<T>(data: T): ServiceResult<T> {
  return { success: true, data };
}

/** Create a failure result. */
export function fail<T = never>(error: string, code?: string): ServiceResult<T> {
  return { success: false, error, code };
}

/**
 * Unwrap a ServiceResult — throws if unsuccessful.
 * Use in CLI/test code that wants throw semantics.
 */
export function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data;
}
