import type { SSHConfig } from '../types/config.js';
import type { GpuUtilization } from '../types/benchmark.js';
import type { SSHClientPool, CommandResult } from './ssh-client.js';
import { createLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Classification categories for health check failures */
export type HealthCheckErrorCategory =
  | 'oom'
  | 'cuda_error'
  | 'gated_repo'
  | 'architecture_not_supported'
  | 'model_not_found'
  | 'disk_space'
  | 'network_error'
  | 'container_crash'
  | 'timeout'
  | 'unknown';

/** Detailed classification of a health check failure */
export interface HealthCheckErrorClassification {
  /** The error category */
  category: HealthCheckErrorCategory;
  /** Human-readable description of the error */
  message: string;
  /** Whether this error is fatal (no point retrying) */
  isFatal: boolean;
  /** Recommended action for recovery */
  recommendation: string;
  /** The raw log lines that matched the error pattern */
  matchedLogLines: string[];
}

/** Result of a health check poll cycle */
export interface HealthCheckPollResult {
  /** Whether the service is healthy */
  healthy: boolean;
  /** Whether the /health endpoint responded successfully */
  healthEndpointOk: boolean;
  /** Whether the /v1/models endpoint responded successfully */
  modelsEndpointOk: boolean;
  /** Whether the container is still running */
  containerRunning: boolean;
  /** Elapsed time in milliseconds since health check started */
  elapsedMs: number;
  /** Error classification if the check failed */
  errorClassification: HealthCheckErrorClassification | null;
  /** Raw container logs (last N lines) when failure detected */
  containerLogs: string | null;
}

/** Final result of the health check process */
export interface HealthCheckResult {
  /** Whether the service became healthy within the timeout */
  healthy: boolean;
  /** Total time taken in milliseconds */
  totalTimeMs: number;
  /** Number of poll attempts made */
  pollAttempts: number;
  /** Error classification if the check failed */
  errorClassification: HealthCheckErrorClassification | null;
  /** Raw container logs at the time of failure/success */
  containerLogs: string | null;
  /** Model information from /v1/models if available */
  modelInfo: VllmModelResponse | null;
}

/** Response from the vLLM /v1/models endpoint */
export interface VllmModelResponse {
  /** Model ID */
  id: string;
  /** Maximum model length */
  maxModelLen: number | null;
  /** Raw response data */
  raw: Record<string, unknown>;
}

/** Configuration options for the health check service */
export interface HealthCheckOptions {
  /** Timeout in milliseconds for health check readiness (default: 600000 = 10 min) */
  timeoutMs?: number;
  /** Interval in milliseconds between health check attempts (default: 10000 = 10 sec) */
  intervalMs?: number;
  /** Port for the vLLM API (default: 8000) */
  apiPort?: number;
  /** Number of tail lines to retrieve from container logs (default: 200) */
  logTailLines?: number;
  /** Timeout in milliseconds for individual SSH commands (default: 10000) */
  commandTimeoutMs?: number;
  /** Whether to run Docker commands with sudo (default: false) */
  useSudo?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_INTERVAL_MS = 10_000; // 10 seconds
const DEFAULT_API_PORT = 8000;
const DEFAULT_LOG_TAIL_LINES = 200;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

// ─── Fatal Error Patterns ─────────────────────────────────────────────────────

/**
 * Patterns for detecting fatal errors from vLLM container logs.
 * Each pattern maps a regex to an error classification.
 *
 * Order matters: more specific patterns should come first.
 */
const FATAL_ERROR_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  category: HealthCheckErrorCategory;
  message: string;
  recommendation: string;
}> = [
  // OOM errors
  {
    pattern: /CUDA out of memory/i,
    category: 'oom',
    message: 'CUDA out of memory: the model requires more GPU VRAM than available',
    recommendation:
      'Try reducing --gpu-memory-utilization, using a smaller model, or adding more GPUs with tensor parallelism',
  },
  {
    pattern: /torch\.(?:cuda\.)?OutOfMemoryError/i,
    category: 'oom',
    message: 'PyTorch CUDA out of memory error during model loading or inference',
    recommendation:
      'Try reducing --gpu-memory-utilization, using a quantized version of the model, or increasing GPU count',
  },
  {
    pattern: /OOM|Out of memory|Cannot allocate memory|MemoryError/i,
    category: 'oom',
    message: 'System or GPU out of memory error',
    recommendation:
      'Ensure the model fits within available VRAM and system memory. Consider reducing batch size or model size',
  },
  {
    pattern: /KV cache.*(?:too large|not enough|insufficient|cannot allocate)/i,
    category: 'oom',
    message: 'Insufficient memory for KV cache allocation',
    recommendation:
      'Reduce --max-model-len or --gpu-memory-utilization to free up VRAM for KV cache',
  },

  // CUDA errors
  {
    pattern: /CUDA error: (?:device-side assert triggered|an illegal memory access|CUBLAS_STATUS)/i,
    category: 'cuda_error',
    message: 'CUDA runtime error detected',
    recommendation:
      'This may indicate a GPU hardware issue or driver incompatibility. Check NVIDIA driver version and GPU health',
  },
  {
    pattern: /NCCL error|NCCL_ERROR|ncclSystemError|ncclInternalError/i,
    category: 'cuda_error',
    message: 'NCCL communication error between GPUs',
    recommendation:
      'Check that all GPUs are accessible and NVLink/PCIe connections are healthy. Try reducing tensor-parallel-size',
  },
  {
    pattern: /RuntimeError:.*CUDA|cuda.*RuntimeError/i,
    category: 'cuda_error',
    message: 'CUDA-related runtime error',
    recommendation:
      'Check GPU driver compatibility with the vLLM version. Consider updating NVIDIA drivers',
  },
  {
    pattern: /no CUDA-capable device|CUDA driver version is insufficient/i,
    category: 'cuda_error',
    message: 'No CUDA-capable GPU found or driver version insufficient',
    recommendation:
      'Verify that NVIDIA GPUs are available and the CUDA driver is compatible with the container runtime',
  },

  // Gated/access errors
  {
    pattern: /Access to model.*is restricted|gated repo|401.*Unauthorized.*huggingface/i,
    category: 'gated_repo',
    message: 'Model access is restricted (gated repository)',
    recommendation:
      'Accept the model license on HuggingFace and ensure HF_TOKEN is set with the correct permissions',
  },
  {
    pattern: /Cannot access gated repo|repository is gated/i,
    category: 'gated_repo',
    message: 'Cannot access gated HuggingFace repository',
    recommendation:
      'Visit the model page on HuggingFace to accept the license agreement, then retry with a valid HF_TOKEN',
  },
  {
    pattern: /Invalid token|token.*expired|authentication.*failed.*huggingface/i,
    category: 'gated_repo',
    message: 'HuggingFace authentication failed',
    recommendation: 'Check that HF_TOKEN is valid, not expired, and has read access to the model repository',
  },

  // Architecture not supported
  {
    pattern: /(?:not supported|unsupported).*(?:architecture|model type)/i,
    category: 'architecture_not_supported',
    message: 'Model architecture is not supported by this version of vLLM',
    recommendation: 'Check vLLM documentation for supported architectures or try a newer vLLM version',
  },
  {
    pattern: /KeyError:.*(?:ForCausalLM|Model)|(?:cannot|unable to).*(?:load|initialize).*model/i,
    category: 'architecture_not_supported',
    message: 'Failed to load model: architecture may not be supported',
    recommendation:
      'Verify the model architecture is supported by the vLLM version in use. Check vLLM release notes for new architecture support',
  },
  {
    pattern: /(?:not implemented|NotImplementedError).*(?:architecture|model|layer)/i,
    category: 'architecture_not_supported',
    message: 'Model architecture requires unimplemented features in vLLM',
    recommendation:
      'This model architecture may not yet be fully supported. Check vLLM GitHub issues for support status',
  },

  // Model not found
  {
    pattern: /(?:model|repository).*(?:not found|does not exist|404)/i,
    category: 'model_not_found',
    message: 'Model not found on HuggingFace',
    recommendation: 'Verify the model ID is correct and the model exists on HuggingFace',
  },
  {
    pattern: /OSError:.*(?:not a valid model|can't load)/i,
    category: 'model_not_found',
    message: 'Unable to load model: model files may be missing or corrupt',
    recommendation: 'Check that the model repository contains valid model files and try clearing the cache',
  },

  // Disk space
  {
    pattern: /No space left on device|ENOSPC|disk.*(?:full|space)/i,
    category: 'disk_space',
    message: 'Insufficient disk space on the host',
    recommendation: 'Free up disk space by removing unused Docker images and model caches',
  },

  // Network errors
  {
    pattern: /(?:ConnectionError|ConnectionRefused|DNS.*(?:resolution|lookup).*failed|timeout.*(?:download|connect))/i,
    category: 'network_error',
    message: 'Network error during model download or initialization',
    recommendation:
      'Check network connectivity and ensure the VM can reach HuggingFace. Consider pre-downloading the model',
  },
];

// ─── Error Classes ──────────────────────────────────────────────────────────

/** Error thrown when the health check process fails */
export class HealthCheckServiceError extends Error {
  constructor(
    message: string,
    public readonly modelId: string,
    public readonly classification: HealthCheckErrorClassification,
    public readonly result: HealthCheckResult,
  ) {
    super(message);
    this.name = 'HealthCheckServiceError';
  }
}

// ─── Health Check Service ──────────────────────────────────────────────────

/**
 * Service for monitoring the health of deployed vLLM instances.
 *
 * Polls /health and /v1/models endpoints with configurable timeout,
 * detects fatal errors from container logs (OOM, CUDA errors, gated
 * repo access, architecture not supported), and provides detailed
 * error classification for failure analysis.
 *
 * @example
 * ```typescript
 * const healthCheck = new HealthCheckService(sshPool, 'info', {
 *   timeoutMs: 600_000,
 *   intervalMs: 10_000,
 * });
 *
 * const result = await healthCheck.waitForHealthy(
 *   sshConfig,
 *   'model-container',
 *   'meta-llama/Llama-3-70B',
 * );
 *
 * if (result.healthy) {
 *   console.log(`Model ready in ${result.totalTimeMs}ms`);
 *   console.log(`Max model len: ${result.modelInfo?.maxModelLen}`);
 * } else {
 *   console.error(`Failed: ${result.errorClassification?.message}`);
 *   console.error(`Category: ${result.errorClassification?.category}`);
 *   console.error(`Recommendation: ${result.errorClassification?.recommendation}`);
 * }
 * ```
 */
export class HealthCheckService {
  private readonly logger;
  private readonly options: Required<HealthCheckOptions>;

  /**
   * Creates a new HealthCheckService instance.
   *
   * @param sshPool - SSH client pool for remote command execution
   * @param logLevel - Winston log level (default: 'info')
   * @param options - Health check configuration options
   */
  constructor(
    private readonly sshPool: SSHClientPool,
    logLevel: string = 'info',
    options: HealthCheckOptions = {},
  ) {
    this.logger = createLogger(logLevel);
    this.options = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
      apiPort: options.apiPort ?? DEFAULT_API_PORT,
      logTailLines: options.logTailLines ?? DEFAULT_LOG_TAIL_LINES,
      commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      useSudo: options.useSudo ?? false,
    };

    this.logger.info('HealthCheckService initialized', {
      timeoutMs: this.options.timeoutMs,
      intervalMs: this.options.intervalMs,
      apiPort: this.options.apiPort,
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Waits for a vLLM container to become healthy by polling endpoints.
   *
   * Polls both /health and /v1/models endpoints. On each cycle:
   * 1. Checks if the container is still running
   * 2. If the container exited, analyzes logs for fatal error classification
   * 3. Checks /health endpoint for basic liveness
   * 4. Checks /v1/models endpoint for model readiness
   * 5. If still unhealthy, inspects recent logs for fatal errors that indicate
   *    the container will never become healthy (e.g., OOM, CUDA errors)
   *
   * @param sshConfig - SSH connection configuration for the target VM
   * @param containerName - Name of the Docker container to monitor
   * @param modelId - The model ID being deployed (for error context)
   * @returns Health check result with status, timing, and error details
   * @throws {HealthCheckServiceError} If the health check fails with a classified error
   */
  async waitForHealthy(
    sshConfig: SSHConfig,
    containerName: string,
    modelId: string,
  ): Promise<HealthCheckResult> {
    const startTime = Date.now();
    let pollAttempts = 0;
    let lastPollResult: HealthCheckPollResult | null = null;

    this.logger.info(`Starting health check for container '${containerName}'`, {
      modelId,
      timeoutMs: this.options.timeoutMs,
      intervalMs: this.options.intervalMs,
    });

    while (Date.now() - startTime < this.options.timeoutMs) {
      pollAttempts++;
      const elapsedMs = Date.now() - startTime;

      // Execute a single poll cycle
      lastPollResult = await this.poll(sshConfig, containerName, modelId, elapsedMs);

      if (lastPollResult.healthy) {
        const totalTimeMs = Date.now() - startTime;
        this.logger.info(
          `Health check PASSED for '${containerName}' after ${totalTimeMs}ms (${pollAttempts} attempts)`,
          { modelId },
        );

        // Fetch model info from /v1/models
        const modelInfo = await this.fetchModelInfo(sshConfig);

        return {
          healthy: true,
          totalTimeMs,
          pollAttempts,
          errorClassification: null,
          containerLogs: null,
          modelInfo,
        };
      }

      // If we got a fatal error classification, fail immediately
      if (lastPollResult.errorClassification?.isFatal) {
        const totalTimeMs = Date.now() - startTime;
        this.logger.error(
          `Fatal error detected for '${containerName}': ${lastPollResult.errorClassification.category}`,
          {
            modelId,
            message: lastPollResult.errorClassification.message,
            elapsedMs: totalTimeMs,
          },
        );

        const result: HealthCheckResult = {
          healthy: false,
          totalTimeMs,
          pollAttempts,
          errorClassification: lastPollResult.errorClassification,
          containerLogs: lastPollResult.containerLogs,
          modelInfo: null,
        };

        throw new HealthCheckServiceError(
          `Health check failed for model ${modelId}: ${lastPollResult.errorClassification.message}`,
          modelId,
          lastPollResult.errorClassification,
          result,
        );
      }

      // Log progress
      this.logger.debug(
        `Health check pending for '${containerName}' (${Math.round(elapsedMs / 1000)}s / ${Math.round(this.options.timeoutMs / 1000)}s)`,
        {
          modelId,
          attempt: pollAttempts,
          containerRunning: lastPollResult.containerRunning,
          healthEndpointOk: lastPollResult.healthEndpointOk,
        },
      );

      // Sleep before retry
      await this.sleep(this.options.intervalMs);
    }

    // Timeout reached
    const totalTimeMs = Date.now() - startTime;
    const logs = await this.getContainerLogs(sshConfig, containerName);

    const timeoutClassification: HealthCheckErrorClassification = {
      category: 'timeout',
      message: `Health check timed out after ${totalTimeMs}ms (${pollAttempts} attempts)`,
      isFatal: true,
      recommendation:
        'The model may need more time to load. Try increasing healthCheckTimeoutMs or check if the model is too large for the available resources',
      matchedLogLines: [],
    };

    // Try to find a more specific error from logs at timeout
    const logBasedClassification = logs ? this.classifyContainerLogs(logs) : null;
    const finalClassification = logBasedClassification ?? timeoutClassification;

    this.logger.error(
      `Health check TIMED OUT for '${containerName}' after ${totalTimeMs}ms`,
      {
        modelId,
        pollAttempts,
        category: finalClassification.category,
      },
    );

    const result: HealthCheckResult = {
      healthy: false,
      totalTimeMs,
      pollAttempts,
      errorClassification: finalClassification,
      containerLogs: logs,
      modelInfo: null,
    };

    throw new HealthCheckServiceError(
      `Health check timed out after ${totalTimeMs}ms for model ${modelId}: ${finalClassification.message}`,
      modelId,
      finalClassification,
      result,
    );
  }

  /**
   * Performs a single health check poll against a container.
   *
   * @param sshConfig - SSH connection configuration
   * @param containerName - Name of the container
   * @param modelId - Model ID for logging context
   * @param elapsedMs - Time elapsed since health check started
   * @returns Poll result with endpoint statuses and error classification
   */
  async poll(
    sshConfig: SSHConfig,
    containerName: string,
    _modelId: string,
    elapsedMs: number,
  ): Promise<HealthCheckPollResult> {
    // Step 1: Check if container is still running
    const containerRunning = await this.isContainerRunning(sshConfig, containerName);

    if (!containerRunning) {
      // Container exited — get logs and classify
      const logs = await this.getContainerLogs(sshConfig, containerName);
      const classification = logs
        ? this.classifyContainerLogs(logs)
        : this.createDefaultClassification('container_crash', 'Container exited unexpectedly');

      return {
        healthy: false,
        healthEndpointOk: false,
        modelsEndpointOk: false,
        containerRunning: false,
        elapsedMs,
        errorClassification: classification,
        containerLogs: logs,
      };
    }

    // Step 2: Check /health endpoint
    const healthEndpointOk = await this.checkHealthEndpoint(sshConfig);

    // Step 3: Check /v1/models endpoint
    const modelsEndpointOk = await this.checkModelsEndpoint(sshConfig);

    // If both endpoints are healthy, we're good
    if (healthEndpointOk && modelsEndpointOk) {
      return {
        healthy: true,
        healthEndpointOk: true,
        modelsEndpointOk: true,
        containerRunning: true,
        elapsedMs,
        errorClassification: null,
        containerLogs: null,
      };
    }

    // If health is ok but models isn't, still consider it healthy
    // (some vLLM versions take longer to report models)
    if (healthEndpointOk) {
      return {
        healthy: true,
        healthEndpointOk: true,
        modelsEndpointOk,
        containerRunning: true,
        elapsedMs,
        errorClassification: null,
        containerLogs: null,
      };
    }

    // Step 4: Container is running but endpoints not ready — check logs for fatal errors
    // Only check logs periodically (every 5th attempt or after 60s) to avoid excessive SSH calls
    let logClassification: HealthCheckErrorClassification | null = null;
    let logs: string | null = null;

    if (elapsedMs > 60_000) {
      logs = await this.getContainerLogs(sshConfig, containerName);
      if (logs) {
        logClassification = this.classifyContainerLogs(logs);
      }
    }

    return {
      healthy: false,
      healthEndpointOk: false,
      modelsEndpointOk: false,
      containerRunning: true,
      elapsedMs,
      errorClassification: logClassification,
      containerLogs: logs,
    };
  }

  /**
   * Classifies container logs to identify fatal errors.
   *
   * Scans the log output against known fatal error patterns and returns
   * a classification with category, message, and recommendation.
   *
   * @param logs - Raw container log output
   * @returns Error classification if a fatal pattern is found, null otherwise
   */
  classifyContainerLogs(logs: string): HealthCheckErrorClassification | null {
    const logLines = logs.split('\n');

    for (const { pattern, category, message, recommendation } of FATAL_ERROR_PATTERNS) {
      const matchedLines = logLines.filter((line) => pattern.test(line));

      if (matchedLines.length > 0) {
        return {
          category,
          message,
          isFatal: true,
          recommendation,
          matchedLogLines: matchedLines.slice(0, 5), // Keep at most 5 matched lines
        };
      }
    }

    return null;
  }

  /**
   * Creates a summary of the health check result suitable for logging or display.
   *
   * @param result - The health check result
   * @returns Human-readable summary string
   */
  formatResultSummary(result: HealthCheckResult): string {
    if (result.healthy) {
      const modelInfo = result.modelInfo
        ? ` (model: ${result.modelInfo.id}, max_model_len: ${result.modelInfo.maxModelLen ?? 'unknown'})`
        : '';
      return `Health check passed in ${result.totalTimeMs}ms after ${result.pollAttempts} attempts${modelInfo}`;
    }

    const classification = result.errorClassification;
    if (!classification) {
      return `Health check failed after ${result.totalTimeMs}ms (${result.pollAttempts} attempts): unknown error`;
    }

    return [
      `Health check failed after ${result.totalTimeMs}ms (${result.pollAttempts} attempts)`,
      `Category: ${classification.category}`,
      `Error: ${classification.message}`,
      `Fatal: ${classification.isFatal}`,
      `Recommendation: ${classification.recommendation}`,
      classification.matchedLogLines.length > 0
        ? `Matched logs:\n  ${classification.matchedLogLines.join('\n  ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Queries GPU utilization metrics via nvidia-smi on the remote VM.
   * Returns null if the query fails (non-critical).
   */
  async queryGpuUtilization(sshConfig: SSHConfig): Promise<GpuUtilization | null> {
    try {
      const result = await this.execSSH(
        sshConfig,
        'nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits',
      );

      if (!result.success || !result.stdout.trim()) {
        this.logger.debug('nvidia-smi query returned no data');
        return null;
      }

      const lines = result.stdout.trim().split('\n').filter((l) => l.trim().length > 0);
      const vramUsedGb: number[] = [];
      const vramTotalGb: number[] = [];
      const gpuUtilPct: number[] = [];

      for (const line of lines) {
        const parts = line.split(',').map((s) => s.trim());
        if (parts.length < 2) continue;

        const usedMiB = parseFloat(parts[0]!);
        const totalMiB = parseFloat(parts[1]!);
        const utilPct = parts[2] !== undefined ? parseFloat(parts[2]) : NaN;

        if (!isNaN(usedMiB) && !isNaN(totalMiB)) {
          vramUsedGb.push(Math.round((usedMiB / 1024) * 100) / 100);
          vramTotalGb.push(Math.round((totalMiB / 1024) * 100) / 100);
        }
        if (!isNaN(utilPct)) {
          gpuUtilPct.push(utilPct);
        }
      }

      if (vramUsedGb.length === 0) {
        this.logger.debug('No valid GPU metrics parsed from nvidia-smi output');
        return null;
      }

      const totalUsed = vramUsedGb.reduce((a, b) => a + b, 0);
      const totalTotal = vramTotalGb.reduce((a, b) => a + b, 0);

      return {
        vramUsedGb,
        vramTotalGb,
        totalVramUsedGb: Math.round(totalUsed * 100) / 100,
        totalVramTotalGb: Math.round(totalTotal * 100) / 100,
        vramUtilizationPct: totalTotal > 0 ? Math.round((totalUsed / totalTotal) * 10000) / 100 : 0,
        gpuUtilizationPct: gpuUtilPct.length > 0 ? gpuUtilPct : null,
      };
    } catch (error) {
      this.logger.debug('Failed to query GPU utilization', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Checks if a Docker container is currently running.
   */
  private async isContainerRunning(
    sshConfig: SSHConfig,
    containerName: string,
  ): Promise<boolean> {
    try {
      const result = await this.execSSH(
        sshConfig,
        `docker inspect --format='{{.State.Running}}' ${containerName}`,
      );
      return result.stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Checks the vLLM /health endpoint.
   */
  private async checkHealthEndpoint(sshConfig: SSHConfig): Promise<boolean> {
    try {
      const result = await this.execSSH(
        sshConfig,
        `curl -sf http://localhost:${this.options.apiPort}/health`,
      );
      return result.success;
    } catch {
      return false;
    }
  }

  /**
   * Checks the vLLM /v1/models endpoint.
   */
  private async checkModelsEndpoint(sshConfig: SSHConfig): Promise<boolean> {
    try {
      const result = await this.execSSH(
        sshConfig,
        `curl -sf http://localhost:${this.options.apiPort}/v1/models`,
      );

      if (!result.success || !result.stdout.trim()) {
        return false;
      }

      // Verify the response is valid JSON with model data
      const response = JSON.parse(result.stdout) as { data?: unknown[] };
      return Array.isArray(response.data) && response.data.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Fetches model information from the /v1/models endpoint.
   */
  private async fetchModelInfo(sshConfig: SSHConfig): Promise<VllmModelResponse | null> {
    try {
      const result = await this.execSSH(
        sshConfig,
        `curl -sf http://localhost:${this.options.apiPort}/v1/models`,
      );

      if (!result.success || !result.stdout.trim()) {
        return null;
      }

      const response = JSON.parse(result.stdout) as {
        data?: Array<{ id?: string; max_model_len?: number; [key: string]: unknown }>;
      };

      const modelData = response.data?.[0];
      if (!modelData) {
        return null;
      }

      return {
        id: modelData.id ?? 'unknown',
        maxModelLen: modelData.max_model_len ?? null,
        raw: modelData as Record<string, unknown>,
      };
    } catch (error) {
      this.logger.debug('Could not fetch model info from /v1/models endpoint', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Retrieves container logs from a Docker container.
   */
  private async getContainerLogs(
    sshConfig: SSHConfig,
    containerName: string,
  ): Promise<string | null> {
    try {
      const result = await this.execSSH(
        sshConfig,
        `docker logs --tail ${this.options.logTailLines} ${containerName} 2>&1`,
      );
      return result.stdout || null;
    } catch {
      return null;
    }
  }

  /**
   * Creates a default error classification for a given category.
   */
  private createDefaultClassification(
    category: HealthCheckErrorCategory,
    message: string,
  ): HealthCheckErrorClassification {
    const recommendations: Record<HealthCheckErrorCategory, string> = {
      oom: 'Try reducing --gpu-memory-utilization or using a smaller model',
      cuda_error: 'Check GPU drivers and hardware health',
      gated_repo: 'Ensure HF_TOKEN is set and model license is accepted',
      architecture_not_supported: 'Check vLLM documentation for supported architectures',
      model_not_found: 'Verify the model ID is correct',
      disk_space: 'Free up disk space on the host',
      network_error: 'Check network connectivity',
      container_crash: 'Check container logs for crash details',
      timeout: 'Increase health check timeout or check resource availability',
      unknown: 'Check container logs for more details',
    };

    return {
      category,
      message,
      isFatal: category !== 'timeout' && category !== 'network_error',
      recommendation: recommendations[category],
      matchedLogLines: [],
    };
  }

  /**
   * Executes an SSH command with consistent error handling.
   */
  private async execSSH(sshConfig: SSHConfig, command: string): Promise<CommandResult> {
    const needsSudo = this.options.useSudo && command.startsWith('docker');
    return await this.sshPool.exec(sshConfig, command, {
      timeout: this.options.commandTimeoutMs,
      sudo: needsSudo,
    });
  }

  /**
   * Promise-based sleep utility.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
