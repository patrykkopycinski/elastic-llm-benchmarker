import type { SSHConfig } from '../types/config.js';
import type { SSHClientPool } from './ssh-client.js';
import { SSHConnectionError, SSHTimeoutError, SSHError } from './ssh-client.js';
import type { VllmDeploymentService } from './vllm-deployment.js';
import { VllmDeploymentError, ContainerError, HealthCheckError } from './vllm-deployment.js';
import { HealthCheckServiceError } from './health-check.js';
import type { HealthCheckErrorCategory } from './health-check.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { createLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Classification of an error for recovery decisions.
 */
export type ErrorCategory =
  | 'ssh_connection'
  | 'ssh_timeout'
  | 'docker_crash'
  | 'benchmark_timeout'
  | 'oom'
  | 'fatal_model_error'
  | 'transient'
  | 'unknown';

/**
 * Recovery action to take for an error.
 */
export type RecoveryAction =
  | 'retry_with_backoff'
  | 'cleanup_and_retry'
  | 'skip_model'
  | 'graceful_terminate'
  | 'abort';

/**
 * Result of an error classification and recovery decision.
 */
export interface ErrorRecoveryDecision {
  /** The classified error category */
  category: ErrorCategory;
  /** The recommended recovery action */
  action: RecoveryAction;
  /** Whether the error should be recorded in the circuit breaker */
  shouldRecordInCircuitBreaker: boolean;
  /** Maximum number of retries for this category */
  maxRetries: number;
  /** Base delay in milliseconds for exponential backoff */
  baseDelayMs: number;
  /** Human-readable explanation of the decision */
  explanation: string;
  /** Whether this error is model-specific (vs infrastructure) */
  isModelSpecific: boolean;
}

/**
 * Options for the ErrorRecoveryService.
 */
export interface ErrorRecoveryOptions {
  /** Maximum retries for SSH connection failures (default: 3) */
  maxSshRetries?: number;
  /** Base delay for SSH retry backoff in ms (default: 5000) */
  sshRetryBaseDelayMs?: number;
  /** Maximum retries for Docker container crashes (default: 2) */
  maxDockerRetries?: number;
  /** Base delay for Docker retry backoff in ms (default: 10000) */
  dockerRetryBaseDelayMs?: number;
  /** Timeout for benchmark graceful termination in ms (default: 30000) */
  benchmarkTerminationTimeoutMs?: number;
  /** Maximum retries for transient errors (default: 2) */
  maxTransientRetries?: number;
  /** Base delay for transient error backoff in ms (default: 3000) */
  transientRetryBaseDelayMs?: number;
}

/**
 * Context for an error recovery attempt, used for tracking retries.
 */
export interface RecoveryContext {
  /** Model ID being processed when the error occurred */
  modelId: string;
  /** Error category */
  category: ErrorCategory;
  /** Number of retry attempts so far */
  attemptNumber: number;
  /** Original error */
  error: Error;
  /** Recovery action decided */
  action: RecoveryAction;
  /** Timestamp of the error */
  timestamp: number;
}

/**
 * Result of executing a recovery action.
 */
export interface RecoveryResult {
  /** Whether recovery was successful */
  success: boolean;
  /** Whether the operation should be retried */
  shouldRetry: boolean;
  /** Action that was taken */
  actionTaken: RecoveryAction;
  /** Delay before retry in ms (if shouldRetry is true) */
  retryDelayMs: number;
  /** Human-readable message about what happened */
  message: string;
  /** Updated context for the next retry */
  context: RecoveryContext;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_SSH_RETRIES = 3;
const DEFAULT_SSH_RETRY_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DOCKER_RETRIES = 2;
const DEFAULT_DOCKER_RETRY_BASE_DELAY_MS = 10_000;
const DEFAULT_BENCHMARK_TERMINATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TRANSIENT_RETRIES = 2;
const DEFAULT_TRANSIENT_RETRY_BASE_DELAY_MS = 3_000;

/**
 * Health check error categories that indicate OOM.
 */
const OOM_CATEGORIES: ReadonlySet<HealthCheckErrorCategory> = new Set(['oom']);

/**
 * Health check error categories that are fatal and model-specific
 * (no point retrying the same model).
 */
const FATAL_MODEL_CATEGORIES: ReadonlySet<HealthCheckErrorCategory> = new Set([
  'oom',
  'cuda_error',
  'gated_repo',
  'architecture_not_supported',
  'model_not_found',
]);

/**
 * Health check error categories that are transient and worth retrying.
 */
const TRANSIENT_CATEGORIES: ReadonlySet<HealthCheckErrorCategory> = new Set([
  'network_error',
  'timeout',
  'disk_space',
]);

// ─── ErrorRecoveryService ────────────────────────────────────────────────────

/**
 * Comprehensive error recovery service for the LLM benchmarking pipeline.
 *
 * Handles four categories of errors with specific recovery strategies:
 *
 * 1. **SSH Connection Failures**: Retry with exponential backoff.
 *    The SSH pool already handles basic retries, but this provides
 *    higher-level recovery for persistent connection issues.
 *
 * 2. **Docker Container Crashes**: Clean up the crashed container and
 *    retry the deployment. Includes force-removal of orphaned containers
 *    and GPU process cleanup.
 *
 * 3. **Benchmark Timeouts**: Gracefully terminate the running benchmark
 *    process and the vLLM container, then record the timeout.
 *
 * 4. **OOM Handling**: Skip the model entirely (it won't fit), record
 *    the failure in the circuit breaker, and move on to the next model.
 *
 * The service integrates with a {@link CircuitBreaker} to prevent
 * repeatedly attempting models that consistently fail.
 *
 * @example
 * ```typescript
 * const recovery = new ErrorRecoveryService(sshPool, deployer, circuitBreaker);
 *
 * try {
 *   await runBenchmark(model);
 * } catch (error) {
 *   const decision = recovery.classifyError(error);
 *   const result = await recovery.execute(sshConfig, {
 *     modelId: model.id,
 *     category: decision.category,
 *     attemptNumber: 1,
 *     error,
 *     action: decision.action,
 *     timestamp: Date.now(),
 *   });
 *
 *   if (result.shouldRetry) {
 *     await sleep(result.retryDelayMs);
 *     // retry the operation...
 *   }
 * }
 * ```
 */
export class ErrorRecoveryService {
  private readonly logger;
  private readonly options: Required<ErrorRecoveryOptions>;
  /** vLLM deployment service for container management (reserved for future use) */
  readonly deployer: VllmDeploymentService;

  /**
   * Creates a new ErrorRecoveryService instance.
   *
   * @param sshPool - SSH client pool for remote operations
   * @param deployer - vLLM deployment service for container management
   * @param circuitBreaker - Circuit breaker for tracking model failures
   * @param logLevel - Winston log level (default: 'info')
   * @param options - Recovery configuration options
   */
  constructor(
    private readonly sshPool: SSHClientPool,
    deployer: VllmDeploymentService,
    private readonly circuitBreaker: CircuitBreaker,
    logLevel: string = 'info',
    options: ErrorRecoveryOptions = {},
  ) {
    this.deployer = deployer;
    this.logger = createLogger(logLevel);
    this.options = {
      maxSshRetries: options.maxSshRetries ?? DEFAULT_MAX_SSH_RETRIES,
      sshRetryBaseDelayMs: options.sshRetryBaseDelayMs ?? DEFAULT_SSH_RETRY_BASE_DELAY_MS,
      maxDockerRetries: options.maxDockerRetries ?? DEFAULT_MAX_DOCKER_RETRIES,
      dockerRetryBaseDelayMs: options.dockerRetryBaseDelayMs ?? DEFAULT_DOCKER_RETRY_BASE_DELAY_MS,
      benchmarkTerminationTimeoutMs:
        options.benchmarkTerminationTimeoutMs ?? DEFAULT_BENCHMARK_TERMINATION_TIMEOUT_MS,
      maxTransientRetries: options.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES,
      transientRetryBaseDelayMs:
        options.transientRetryBaseDelayMs ?? DEFAULT_TRANSIENT_RETRY_BASE_DELAY_MS,
    };

    this.logger.info('ErrorRecoveryService initialized', {
      maxSshRetries: this.options.maxSshRetries,
      maxDockerRetries: this.options.maxDockerRetries,
      benchmarkTerminationTimeoutMs: this.options.benchmarkTerminationTimeoutMs,
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Classifies an error and determines the appropriate recovery action.
   *
   * @param error - The error to classify
   * @returns Recovery decision with category, action, and retry parameters
   */
  classifyError(error: unknown): ErrorRecoveryDecision {
    // SSH connection failures
    if (error instanceof SSHConnectionError) {
      return {
        category: 'ssh_connection',
        action: 'retry_with_backoff',
        shouldRecordInCircuitBreaker: false,
        maxRetries: this.options.maxSshRetries,
        baseDelayMs: this.options.sshRetryBaseDelayMs,
        explanation: `SSH connection failed to ${error.host}: ${error.message}. Will retry with exponential backoff.`,
        isModelSpecific: false,
      };
    }

    // SSH timeout errors
    if (error instanceof SSHTimeoutError) {
      return {
        category: 'ssh_timeout',
        action: 'graceful_terminate',
        shouldRecordInCircuitBreaker: false,
        maxRetries: this.options.maxTransientRetries,
        baseDelayMs: this.options.transientRetryBaseDelayMs,
        explanation: `SSH command timed out on ${error.host}: ${error.command}. Will gracefully terminate and retry.`,
        isModelSpecific: false,
      };
    }

    // Health check service errors (most detailed classification)
    if (error instanceof HealthCheckServiceError) {
      return this.classifyHealthCheckError(error);
    }

    // Container errors
    if (error instanceof ContainerError) {
      return {
        category: 'docker_crash',
        action: 'cleanup_and_retry',
        shouldRecordInCircuitBreaker: true,
        maxRetries: this.options.maxDockerRetries,
        baseDelayMs: this.options.dockerRetryBaseDelayMs,
        explanation: `Docker ${error.operation} failed for ${error.containerName}: ${error.message}. Will cleanup and retry.`,
        isModelSpecific: false,
      };
    }

    // Health check timeout (from vllm-deployment)
    if (error instanceof HealthCheckError) {
      return {
        category: 'benchmark_timeout',
        action: 'graceful_terminate',
        shouldRecordInCircuitBreaker: true,
        maxRetries: 1,
        baseDelayMs: this.options.dockerRetryBaseDelayMs,
        explanation: `Health check timed out after ${error.timeoutMs}ms for model ${error.modelId}. Will terminate container.`,
        isModelSpecific: true,
      };
    }

    // Generic vLLM deployment errors
    if (error instanceof VllmDeploymentError) {
      return {
        category: 'docker_crash',
        action: 'cleanup_and_retry',
        shouldRecordInCircuitBreaker: true,
        maxRetries: this.options.maxDockerRetries,
        baseDelayMs: this.options.dockerRetryBaseDelayMs,
        explanation: `vLLM deployment error for model ${error.modelId}: ${error.message}. Will cleanup and retry.`,
        isModelSpecific: false,
      };
    }

    // Generic SSH errors
    if (error instanceof SSHError) {
      return {
        category: 'ssh_connection',
        action: 'retry_with_backoff',
        shouldRecordInCircuitBreaker: false,
        maxRetries: this.options.maxSshRetries,
        baseDelayMs: this.options.sshRetryBaseDelayMs,
        explanation: `SSH error on ${error.host}: ${error.message}. Will retry with backoff.`,
        isModelSpecific: false,
      };
    }

    // Timeout-related error messages
    if (error instanceof Error && /timeout|timed?\s*out/i.test(error.message)) {
      return {
        category: 'benchmark_timeout',
        action: 'graceful_terminate',
        shouldRecordInCircuitBreaker: true,
        maxRetries: 1,
        baseDelayMs: this.options.transientRetryBaseDelayMs,
        explanation: `Timeout error: ${error.message}. Will gracefully terminate.`,
        isModelSpecific: false,
      };
    }

    // OOM-related error messages
    if (error instanceof Error && /out of memory|OOM|MemoryError/i.test(error.message)) {
      return {
        category: 'oom',
        action: 'skip_model',
        shouldRecordInCircuitBreaker: true,
        maxRetries: 0,
        baseDelayMs: 0,
        explanation: `Out of memory: ${error.message}. Model will be skipped.`,
        isModelSpecific: true,
      };
    }

    // Unknown errors
    return {
      category: 'unknown',
      action: 'retry_with_backoff',
      shouldRecordInCircuitBreaker: true,
      maxRetries: this.options.maxTransientRetries,
      baseDelayMs: this.options.transientRetryBaseDelayMs,
      explanation: `Unknown error: ${error instanceof Error ? error.message : String(error)}. Will retry with backoff.`,
      isModelSpecific: false,
    };
  }

  /**
   * Executes a recovery action for a given error context.
   *
   * @param sshConfig - SSH connection configuration
   * @param context - The recovery context with error details
   * @returns Result of the recovery action
   */
  async execute(sshConfig: SSHConfig, context: RecoveryContext): Promise<RecoveryResult> {
    this.logger.info(`Executing recovery action: ${context.action}`, {
      modelId: context.modelId,
      category: context.category,
      attemptNumber: context.attemptNumber,
    });

    // Record in circuit breaker if appropriate
    const decision = this.classifyError(context.error);
    if (decision.shouldRecordInCircuitBreaker) {
      this.circuitBreaker.recordFailure(
        context.modelId,
        context.error.message,
        context.category,
      );
    }

    switch (context.action) {
      case 'retry_with_backoff':
        return this.handleRetryWithBackoff(context, decision);

      case 'cleanup_and_retry':
        return this.handleCleanupAndRetry(sshConfig, context, decision);

      case 'graceful_terminate':
        return this.handleGracefulTerminate(sshConfig, context, decision);

      case 'skip_model':
        return this.handleSkipModel(context);

      case 'abort':
        return this.handleAbort(context);

      default:
        return this.handleAbort(context);
    }
  }

  /**
   * Performs Docker container cleanup on the remote VM.
   * Stops and removes all vLLM containers and cleans up GPU processes.
   *
   * @param sshConfig - SSH connection configuration
   * @param containerName - Optional specific container name to clean up
   */
  async cleanupContainers(sshConfig: SSHConfig, containerName?: string): Promise<void> {
    this.logger.info('Performing Docker container cleanup', { containerName });

    try {
      if (containerName) {
        // Stop and remove specific container
        await this.sshPool.exec(sshConfig, `docker stop ${containerName} 2>/dev/null || true`, {
          timeout: 15_000,
        });
        await this.sshPool.exec(sshConfig, `docker rm -f ${containerName} 2>/dev/null || true`, {
          timeout: 15_000,
        });
      }

      // List and remove all vLLM containers
      const listResult = await this.sshPool.exec(
        sshConfig,
        'docker ps -a --filter "ancestor=vllm/vllm-openai" --format "{{.Names}}"',
        { timeout: 10_000 },
      );

      if (listResult.success && listResult.stdout.trim()) {
        const containers = listResult.stdout.trim().split('\n').filter(Boolean);
        for (const name of containers) {
          await this.sshPool.exec(sshConfig, `docker rm -f ${name} 2>/dev/null || true`, {
            timeout: 15_000,
          });
          this.logger.debug(`Removed container: ${name}`);
        }
      }

      // Clean up GPU processes that might be orphaned
      await this.sshPool.exec(
        sshConfig,
        'nvidia-smi --query-compute-apps=pid --format=csv,noheader | xargs -r kill -9 2>/dev/null || true',
        { timeout: 10_000 },
      );

      this.logger.info('Docker container cleanup completed');
    } catch (error) {
      this.logger.warn('Error during container cleanup (non-fatal)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Gracefully terminates a running benchmark by stopping the container.
   *
   * @param sshConfig - SSH connection configuration
   * @param containerName - The container running the benchmark
   */
  async gracefullyTerminateBenchmark(
    sshConfig: SSHConfig,
    containerName: string,
  ): Promise<void> {
    this.logger.info(`Gracefully terminating benchmark in container: ${containerName}`);

    try {
      // First try graceful stop (SIGTERM)
      const stopResult = await this.sshPool.exec(
        sshConfig,
        `docker stop --time=15 ${containerName}`,
        { timeout: this.options.benchmarkTerminationTimeoutMs },
      );

      if (stopResult.success) {
        this.logger.info(`Container ${containerName} stopped gracefully`);
      } else {
        // Force kill if graceful stop failed
        this.logger.warn(`Graceful stop failed, force-killing container: ${containerName}`);
        await this.sshPool.exec(sshConfig, `docker kill ${containerName} 2>/dev/null || true`, {
          timeout: 10_000,
        });
      }

      // Remove the container
      await this.sshPool.exec(sshConfig, `docker rm -f ${containerName} 2>/dev/null || true`, {
        timeout: 10_000,
      });
    } catch (error) {
      this.logger.warn(`Error during graceful termination of ${containerName}`, {
        error: error instanceof Error ? error.message : String(error),
      });

      // Last resort: force cleanup
      try {
        await this.sshPool.exec(sshConfig, `docker rm -f ${containerName} 2>/dev/null || true`, {
          timeout: 10_000,
        });
      } catch {
        // Ignore errors during last-resort cleanup
      }
    }
  }

  /**
   * Creates a RecoveryContext for a new error.
   *
   * @param modelId - Model ID being processed
   * @param error - The error that occurred
   * @param attemptNumber - Current attempt number (starts at 1)
   * @returns A new RecoveryContext
   */
  createContext(modelId: string, error: Error, attemptNumber: number = 1): RecoveryContext {
    const decision = this.classifyError(error);
    return {
      modelId,
      category: decision.category,
      attemptNumber,
      error,
      action: decision.action,
      timestamp: Date.now(),
    };
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Classifies health check service errors into specific recovery decisions.
   */
  private classifyHealthCheckError(error: HealthCheckServiceError): ErrorRecoveryDecision {
    const classification = error.classification;
    const category = classification.category;

    // OOM errors → skip model
    if (OOM_CATEGORIES.has(category)) {
      return {
        category: 'oom',
        action: 'skip_model',
        shouldRecordInCircuitBreaker: true,
        maxRetries: 0,
        baseDelayMs: 0,
        explanation: `OOM for model ${error.modelId}: ${classification.message}. Model will be skipped.`,
        isModelSpecific: true,
      };
    }

    // Fatal model-specific errors → skip model
    if (FATAL_MODEL_CATEGORIES.has(category)) {
      return {
        category: 'fatal_model_error',
        action: 'skip_model',
        shouldRecordInCircuitBreaker: true,
        maxRetries: 0,
        baseDelayMs: 0,
        explanation: `Fatal error for model ${error.modelId}: ${classification.message}. Model will be skipped.`,
        isModelSpecific: true,
      };
    }

    // Container crash → cleanup and retry
    if (category === 'container_crash') {
      return {
        category: 'docker_crash',
        action: 'cleanup_and_retry',
        shouldRecordInCircuitBreaker: true,
        maxRetries: this.options.maxDockerRetries,
        baseDelayMs: this.options.dockerRetryBaseDelayMs,
        explanation: `Container crashed for model ${error.modelId}: ${classification.message}. Will cleanup and retry.`,
        isModelSpecific: false,
      };
    }

    // Transient errors → retry with backoff
    if (TRANSIENT_CATEGORIES.has(category)) {
      return {
        category: 'transient',
        action: 'retry_with_backoff',
        shouldRecordInCircuitBreaker: false,
        maxRetries: this.options.maxTransientRetries,
        baseDelayMs: this.options.transientRetryBaseDelayMs,
        explanation: `Transient error for model ${error.modelId}: ${classification.message}. Will retry.`,
        isModelSpecific: false,
      };
    }

    // Unknown → retry with backoff
    return {
      category: 'unknown',
      action: 'retry_with_backoff',
      shouldRecordInCircuitBreaker: true,
      maxRetries: this.options.maxTransientRetries,
      baseDelayMs: this.options.transientRetryBaseDelayMs,
      explanation: `Unknown health check error for model ${error.modelId}: ${classification.message}. Will retry.`,
      isModelSpecific: false,
    };
  }

  /**
   * Handles retry-with-backoff recovery.
   */
  private handleRetryWithBackoff(
    context: RecoveryContext,
    decision: ErrorRecoveryDecision,
  ): RecoveryResult {
    const canRetry = context.attemptNumber < decision.maxRetries;
    const delayMs = canRetry
      ? this.calculateBackoffDelay(decision.baseDelayMs, context.attemptNumber)
      : 0;

    if (canRetry) {
      this.logger.info(
        `Retry with backoff: attempt ${context.attemptNumber + 1}/${decision.maxRetries} for ${context.modelId}`,
        { delayMs, category: context.category },
      );
    } else {
      this.logger.warn(
        `Max retries (${decision.maxRetries}) exhausted for ${context.modelId}`,
        { category: context.category },
      );
    }

    return {
      success: false,
      shouldRetry: canRetry,
      actionTaken: 'retry_with_backoff',
      retryDelayMs: delayMs,
      message: canRetry
        ? `Will retry in ${Math.ceil(delayMs / 1000)}s (attempt ${context.attemptNumber + 1}/${decision.maxRetries})`
        : `Max retries exhausted (${decision.maxRetries}). Giving up.`,
      context: {
        ...context,
        attemptNumber: context.attemptNumber + 1,
      },
    };
  }

  /**
   * Handles cleanup-and-retry recovery for Docker container crashes.
   */
  private async handleCleanupAndRetry(
    sshConfig: SSHConfig,
    context: RecoveryContext,
    decision: ErrorRecoveryDecision,
  ): Promise<RecoveryResult> {
    // Perform cleanup
    await this.cleanupContainers(sshConfig);

    const canRetry = context.attemptNumber < decision.maxRetries;
    const delayMs = canRetry
      ? this.calculateBackoffDelay(decision.baseDelayMs, context.attemptNumber)
      : 0;

    if (canRetry) {
      this.logger.info(
        `Cleanup complete, will retry: attempt ${context.attemptNumber + 1}/${decision.maxRetries} for ${context.modelId}`,
        { delayMs },
      );
    } else {
      this.logger.warn(
        `Cleanup complete but max retries (${decision.maxRetries}) exhausted for ${context.modelId}`,
      );
    }

    return {
      success: false,
      shouldRetry: canRetry,
      actionTaken: 'cleanup_and_retry',
      retryDelayMs: delayMs,
      message: canRetry
        ? `Containers cleaned up. Will retry in ${Math.ceil(delayMs / 1000)}s (attempt ${context.attemptNumber + 1}/${decision.maxRetries})`
        : `Containers cleaned up. Max retries exhausted (${decision.maxRetries}).`,
      context: {
        ...context,
        attemptNumber: context.attemptNumber + 1,
      },
    };
  }

  /**
   * Handles graceful termination of timed-out operations.
   */
  private async handleGracefulTerminate(
    sshConfig: SSHConfig,
    context: RecoveryContext,
    decision: ErrorRecoveryDecision,
  ): Promise<RecoveryResult> {
    // Cleanup all containers
    await this.cleanupContainers(sshConfig);

    const canRetry = context.attemptNumber < decision.maxRetries;
    const delayMs = canRetry
      ? this.calculateBackoffDelay(decision.baseDelayMs, context.attemptNumber)
      : 0;

    this.logger.info(`Graceful termination complete for ${context.modelId}`, {
      canRetry,
      attemptNumber: context.attemptNumber,
    });

    return {
      success: false,
      shouldRetry: canRetry,
      actionTaken: 'graceful_terminate',
      retryDelayMs: delayMs,
      message: canRetry
        ? `Benchmark terminated gracefully. Will retry in ${Math.ceil(delayMs / 1000)}s`
        : `Benchmark terminated. Max retries exhausted.`,
      context: {
        ...context,
        attemptNumber: context.attemptNumber + 1,
      },
    };
  }

  /**
   * Handles skipping a model due to OOM or fatal model-specific errors.
   */
  private handleSkipModel(context: RecoveryContext): RecoveryResult {
    this.logger.warn(`Skipping model ${context.modelId} due to ${context.category}`, {
      error: context.error.message,
    });

    // Record failure in circuit breaker
    this.circuitBreaker.recordFailure(
      context.modelId,
      context.error.message,
      context.category,
    );

    return {
      success: false,
      shouldRetry: false,
      actionTaken: 'skip_model',
      retryDelayMs: 0,
      message: `Model ${context.modelId} skipped: ${context.error.message}`,
      context: {
        ...context,
        attemptNumber: context.attemptNumber + 1,
      },
    };
  }

  /**
   * Handles abort — no recovery possible.
   */
  private handleAbort(context: RecoveryContext): RecoveryResult {
    this.logger.error(`Aborting recovery for ${context.modelId}`, {
      category: context.category,
      error: context.error.message,
    });

    return {
      success: false,
      shouldRetry: false,
      actionTaken: 'abort',
      retryDelayMs: 0,
      message: `Recovery aborted for ${context.modelId}: ${context.error.message}`,
      context,
    };
  }

  /**
   * Calculates exponential backoff delay with jitter.
   *
   * @param baseDelayMs - Base delay in milliseconds
   * @param attempt - Current attempt number (1-based)
   * @returns Delay in milliseconds with jitter
   */
  private calculateBackoffDelay(baseDelayMs: number, attempt: number): number {
    // Exponential backoff: baseDelay * 2^(attempt-1)
    const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);

    // Add jitter: ±25% of the delay
    const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);

    // Cap at 5 minutes
    return Math.min(exponentialDelay + jitter, 300_000);
  }
}
