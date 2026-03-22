import { createLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Configuration options for the CircuitBreaker.
 */
export interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit (default: 3) */
  failureThreshold?: number;
  /** Time in milliseconds before attempting to reset from OPEN to HALF_OPEN (default: 300000 = 5 min) */
  resetTimeoutMs?: number;
  /** Number of successes in HALF_OPEN state before fully closing (default: 1) */
  successThreshold?: number;
  /** Time in milliseconds after which failure counts are reset if no new failures occur (default: 600000 = 10 min) */
  failureWindowMs?: number;
}

/** Possible states of a circuit breaker */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Failure record for a single model */
export interface ModelFailureRecord {
  /** Model ID */
  modelId: string;
  /** Number of consecutive failures */
  failureCount: number;
  /** Timestamp of the last failure */
  lastFailureAt: number;
  /** Timestamp of the first failure in the current window */
  firstFailureAt: number;
  /** Current circuit state */
  state: CircuitState;
  /** Timestamp when the circuit was opened */
  openedAt: number | null;
  /** Number of successes in HALF_OPEN state */
  halfOpenSuccesses: number;
  /** Last failure reasons for debugging */
  lastFailureReasons: string[];
  /** Error categories that triggered the circuit */
  failureCategories: string[];
}

/** Result of checking whether a model is allowed to proceed */
export interface CircuitCheckResult {
  /** Whether the model is allowed (circuit is CLOSED or HALF_OPEN) */
  allowed: boolean;
  /** Current circuit state for the model */
  state: CircuitState;
  /** Human-readable reason if not allowed */
  reason: string | null;
  /** Time remaining before the circuit can be retried (ms), null if allowed */
  retryAfterMs: number | null;
}

/** Serializable snapshot of all circuit breaker state */
export interface CircuitBreakerSnapshot {
  /** All model failure records */
  records: ModelFailureRecord[];
  /** Timestamp of the snapshot */
  timestamp: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_RESET_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_SUCCESS_THRESHOLD = 1;
const DEFAULT_FAILURE_WINDOW_MS = 600_000; // 10 minutes
const MAX_FAILURE_REASONS = 5;

// ─── CircuitBreaker Service ──────────────────────────────────────────────────

/**
 * Circuit breaker for tracking repeated failures on the same model.
 *
 * Implements the standard circuit breaker pattern with three states:
 * - **CLOSED**: Normal operation. Failures are counted. Once the failure
 *   threshold is reached, the circuit opens.
 * - **OPEN**: The model is blocked from further attempts. After the reset
 *   timeout expires, the circuit transitions to HALF_OPEN.
 * - **HALF_OPEN**: A single test attempt is allowed. If it succeeds,
 *   the circuit closes. If it fails, the circuit reopens.
 *
 * Features:
 * - Per-model failure tracking with configurable thresholds
 * - Time-windowed failure counting (failures expire after a configurable window)
 * - Serializable state for persistence across restarts
 * - Detailed failure records for debugging and reporting
 *
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 300_000 });
 *
 * // Check before attempting a benchmark
 * const check = breaker.canAttempt('meta-llama/Llama-3-70B');
 * if (!check.allowed) {
 *   console.log(`Skipping model: ${check.reason}`);
 *   return;
 * }
 *
 * // Record outcome
 * try {
 *   await runBenchmark(model);
 *   breaker.recordSuccess('meta-llama/Llama-3-70B');
 * } catch (error) {
 *   breaker.recordFailure('meta-llama/Llama-3-70B', error.message, 'oom');
 * }
 * ```
 */
export class CircuitBreaker {
  private readonly logger;
  private readonly options: Required<CircuitBreakerOptions>;
  private readonly records: Map<string, ModelFailureRecord> = new Map();

  /**
   * Creates a new CircuitBreaker instance.
   *
   * @param options - Circuit breaker configuration
   * @param logLevel - Winston log level (default: 'info')
   */
  constructor(options: CircuitBreakerOptions = {}, logLevel: string = 'info') {
    this.logger = createLogger(logLevel);
    this.options = {
      failureThreshold: options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      resetTimeoutMs: options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS,
      successThreshold: options.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD,
      failureWindowMs: options.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS,
    };

    this.logger.info('CircuitBreaker initialized', {
      failureThreshold: this.options.failureThreshold,
      resetTimeoutMs: this.options.resetTimeoutMs,
      successThreshold: this.options.successThreshold,
      failureWindowMs: this.options.failureWindowMs,
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Checks whether a model is allowed to proceed with a benchmark attempt.
   *
   * @param modelId - The model ID to check
   * @returns Result indicating whether the model is allowed and why
   */
  canAttempt(modelId: string): CircuitCheckResult {
    const record = this.records.get(modelId);

    // No record means no failures — always allowed
    if (!record) {
      return { allowed: true, state: 'CLOSED', reason: null, retryAfterMs: null };
    }

    // Clean up expired failure windows
    this.cleanExpiredFailures(record);

    switch (record.state) {
      case 'CLOSED':
        return { allowed: true, state: 'CLOSED', reason: null, retryAfterMs: null };

      case 'HALF_OPEN':
        return { allowed: true, state: 'HALF_OPEN', reason: null, retryAfterMs: null };

      case 'OPEN': {
        const now = Date.now();
        const elapsedSinceOpen = now - (record.openedAt ?? now);

        if (elapsedSinceOpen >= this.options.resetTimeoutMs) {
          // Transition to HALF_OPEN
          record.state = 'HALF_OPEN';
          record.halfOpenSuccesses = 0;

          this.logger.info(`Circuit HALF_OPEN for model: ${modelId}`, {
            elapsedSinceOpen,
            failureCount: record.failureCount,
          });

          return { allowed: true, state: 'HALF_OPEN', reason: null, retryAfterMs: null };
        }

        const retryAfterMs = this.options.resetTimeoutMs - elapsedSinceOpen;
        const reason = `Circuit OPEN for model '${modelId}': ${record.failureCount} consecutive failures. ` +
          `Retry after ${Math.ceil(retryAfterMs / 1000)}s. ` +
          `Last failure: ${record.lastFailureReasons[record.lastFailureReasons.length - 1] ?? 'unknown'}`;

        return { allowed: false, state: 'OPEN', reason, retryAfterMs };
      }
    }
  }

  /**
   * Records a failure for a model.
   *
   * Increments the failure count and may open the circuit if the
   * threshold is reached.
   *
   * @param modelId - The model ID that failed
   * @param reason - Human-readable failure reason
   * @param category - Error category (e.g., 'oom', 'ssh_failure', 'timeout')
   */
  recordFailure(modelId: string, reason: string, category: string = 'unknown'): void {
    const now = Date.now();
    let record = this.records.get(modelId);

    if (!record) {
      record = {
        modelId,
        failureCount: 0,
        lastFailureAt: now,
        firstFailureAt: now,
        state: 'CLOSED',
        openedAt: null,
        halfOpenSuccesses: 0,
        lastFailureReasons: [],
        failureCategories: [],
      };
      this.records.set(modelId, record);
    }

    record.failureCount += 1;
    record.lastFailureAt = now;

    // Track failure reasons (keep last N)
    record.lastFailureReasons.push(reason);
    if (record.lastFailureReasons.length > MAX_FAILURE_REASONS) {
      record.lastFailureReasons.shift();
    }

    // Track failure categories (unique)
    if (!record.failureCategories.includes(category)) {
      record.failureCategories.push(category);
    }

    this.logger.warn(`Circuit breaker failure recorded for model: ${modelId}`, {
      failureCount: record.failureCount,
      threshold: this.options.failureThreshold,
      category,
      reason,
      state: record.state,
    });

    // Check if we should open the circuit
    if (record.state === 'HALF_OPEN') {
      // Any failure in HALF_OPEN immediately reopens
      record.state = 'OPEN';
      record.openedAt = now;
      record.halfOpenSuccesses = 0;

      this.logger.warn(`Circuit REOPENED for model: ${modelId} (failed in HALF_OPEN)`, {
        failureCount: record.failureCount,
      });
    } else if (record.state === 'CLOSED' && record.failureCount >= this.options.failureThreshold) {
      record.state = 'OPEN';
      record.openedAt = now;

      this.logger.warn(`Circuit OPENED for model: ${modelId}`, {
        failureCount: record.failureCount,
        threshold: this.options.failureThreshold,
        categories: record.failureCategories,
      });
    }
  }

  /**
   * Records a success for a model.
   *
   * In HALF_OPEN state, may close the circuit if the success threshold is met.
   * In CLOSED state, resets the failure count.
   *
   * @param modelId - The model ID that succeeded
   */
  recordSuccess(modelId: string): void {
    const record = this.records.get(modelId);

    if (!record) {
      return; // No record to update
    }

    if (record.state === 'HALF_OPEN') {
      record.halfOpenSuccesses += 1;

      if (record.halfOpenSuccesses >= this.options.successThreshold) {
        // Fully close the circuit
        record.state = 'CLOSED';
        record.failureCount = 0;
        record.openedAt = null;
        record.halfOpenSuccesses = 0;
        record.lastFailureReasons = [];
        record.failureCategories = [];

        this.logger.info(`Circuit CLOSED for model: ${modelId} (recovered after HALF_OPEN)`, {
          successThreshold: this.options.successThreshold,
        });
      } else {
        this.logger.info(`HALF_OPEN success for model: ${modelId}`, {
          halfOpenSuccesses: record.halfOpenSuccesses,
          successThreshold: this.options.successThreshold,
        });
      }
    } else if (record.state === 'CLOSED') {
      // Reset failure tracking on success
      record.failureCount = 0;
      record.lastFailureReasons = [];
      record.failureCategories = [];
    }
  }

  /**
   * Gets the failure record for a specific model.
   *
   * @param modelId - The model ID to look up
   * @returns The failure record, or null if no failures recorded
   */
  getRecord(modelId: string): Readonly<ModelFailureRecord> | null {
    return this.records.get(modelId) ?? null;
  }

  /**
   * Gets failure records for all tracked models.
   *
   * @returns Array of all model failure records
   */
  getAllRecords(): ReadonlyArray<Readonly<ModelFailureRecord>> {
    return [...this.records.values()];
  }

  /**
   * Gets all models currently blocked by the circuit breaker (OPEN state).
   *
   * @returns Array of model IDs with OPEN circuits
   */
  getBlockedModels(): string[] {
    const blocked: string[] = [];

    for (const [modelId, record] of this.records) {
      if (record.state === 'OPEN') {
        const now = Date.now();
        const elapsedSinceOpen = now - (record.openedAt ?? now);

        // Only consider truly blocked (not yet eligible for HALF_OPEN)
        if (elapsedSinceOpen < this.options.resetTimeoutMs) {
          blocked.push(modelId);
        }
      }
    }

    return blocked;
  }

  /**
   * Manually resets the circuit for a specific model.
   * Useful for administrative overrides.
   *
   * @param modelId - The model ID to reset
   */
  reset(modelId: string): void {
    this.records.delete(modelId);
    this.logger.info(`Circuit manually reset for model: ${modelId}`);
  }

  /**
   * Resets all circuit breaker state.
   */
  resetAll(): void {
    this.records.clear();
    this.logger.info('All circuit breaker state reset');
  }

  /**
   * Creates a serializable snapshot of the circuit breaker state.
   * Useful for persisting state to disk or sending over the wire.
   *
   * @returns Snapshot of all circuit breaker state
   */
  snapshot(): CircuitBreakerSnapshot {
    return {
      records: [...this.records.values()].map((record) => ({ ...record })),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Restores circuit breaker state from a snapshot.
   *
   * @param snapshot - Previously saved snapshot
   */
  restore(snapshot: CircuitBreakerSnapshot): void {
    this.records.clear();

    for (const record of snapshot.records) {
      this.records.set(record.modelId, { ...record });
    }

    this.logger.info(`Circuit breaker state restored from snapshot`, {
      modelCount: snapshot.records.length,
      snapshotTimestamp: snapshot.timestamp,
    });
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Cleans up expired failure records based on the failure window.
   * If all failures in a CLOSED circuit are older than the window,
   * the failure count is reset.
   */
  private cleanExpiredFailures(record: ModelFailureRecord): void {
    if (record.state !== 'CLOSED') {
      return;
    }

    const now = Date.now();
    if (now - record.lastFailureAt > this.options.failureWindowMs) {
      record.failureCount = 0;
      record.firstFailureAt = now;
      record.lastFailureReasons = [];
      record.failureCategories = [];
    }
  }
}
