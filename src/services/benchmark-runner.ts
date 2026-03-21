import type { SSHConfig, BenchmarkThresholds } from '../types/config.js';
import { resolveMaxITLMs } from '../types/config.js';
import type { BenchmarkMetrics } from '../types/benchmark.js';
import type { SSHClientPool, CommandResult } from './ssh-client.js';
import { createLogger } from '../utils/logger.js';
import { parseBenchmarkOutput } from './benchmark-output-parser.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Configuration options for the benchmark runner */
export interface BenchmarkRunnerOptions {
  /** Port where the vLLM API is running (default: 8000) */
  apiPort?: number;
  /** Number of prompts to generate per benchmark run (default: 200) */
  numPrompts?: number;
  /** Timeout in milliseconds per concurrency-level benchmark (default: 600000 = 10 min) */
  benchmarkTimeoutMs?: number;
  /** Dataset name for the benchmark (default: 'sonnet') */
  dataset?: string;
  /** Sonnet input length (default: 256) */
  sonnetInputLen?: number;
  /** Sonnet prefix length (default: 50) */
  sonnetPrefixLen?: number;
  /** Random output length for generation (default: 128) */
  randomOutputLen?: number;
  /** Random input length for generation (default: 256) */
  randomInputLen?: number;
  /** Whether to run Docker commands with sudo (default: false) */
  useSudo?: boolean;
}

/** Result of a single benchmark run at a given concurrency level */
export interface BenchmarkRunResult {
  /** Concurrency level used */
  concurrencyLevel: number;
  /** Parsed benchmark metrics */
  metrics: BenchmarkMetrics;
  /** Raw stdout output from vllm bench serve */
  rawOutput: string;
  /** Duration of the benchmark execution in milliseconds */
  durationMs: number;
  /** Whether the benchmark completed successfully */
  success: boolean;
  /** Error message if the benchmark failed */
  error?: string;
}

/** Complete result from running benchmarks at all concurrency levels */
export interface FullBenchmarkResult {
  /** Model ID that was benchmarked */
  modelId: string;
  /** Results for each concurrency level */
  runs: BenchmarkRunResult[];
  /** Combined raw output from all runs */
  combinedRawOutput: string;
  /** Whether all benchmark runs succeeded */
  allSucceeded: boolean;
  /** Rejection reasons based on threshold violations */
  rejectionReasons: string[];
  /** Whether the benchmark passed all thresholds */
  passed: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_API_PORT = 8000;
const DEFAULT_NUM_PROMPTS = 200;
const DEFAULT_BENCHMARK_TIMEOUT_MS = 1_800_000; // 30 minutes (200 prompts at concurrency=1 on 70B takes ~20min)
const DEFAULT_DATASET = 'sonnet';
const DEFAULT_SONNET_INPUT_LEN = 256;
const DEFAULT_SONNET_PREFIX_LEN = 50;
const DEFAULT_RANDOM_OUTPUT_LEN = 128;
const DEFAULT_RANDOM_INPUT_LEN = 256;

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Error thrown when a benchmark execution fails */
export class BenchmarkRunnerError extends Error {
  constructor(
    message: string,
    public readonly modelId: string,
    public readonly concurrencyLevel: number,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'BenchmarkRunnerError';
  }
}

// ─── Benchmark Runner Service ─────────────────────────────────────────────────

/**
 * Service for running vLLM benchmarks via `vllm bench serve` on a remote VM.
 *
 * Executes throughput tests at multiple concurrency levels and parses
 * the output to extract key performance metrics:
 * - ITL (Inter-Token Latency)
 * - TTFT (Time To First Token)
 * - Throughput (tokens/sec)
 * - P99 latencies
 *
 * @example
 * ```typescript
 * const runner = new BenchmarkRunnerService(sshPool, 'info');
 * const result = await runner.runBenchmarks(
 *   sshConfig,
 *   'meta-llama/Llama-3-70B-Instruct',
 *   [1, 4, 16],
 *   thresholds,
 * );
 * console.log(`Passed: ${result.passed}`);
 * console.log(`Metrics:`, result.runs.map(r => r.metrics));
 * ```
 */
export class BenchmarkRunnerService {
  private readonly logger;
  private readonly options: Required<Omit<BenchmarkRunnerOptions, 'useSudo'>> & { useSudo: boolean };

  /**
   * Creates a new BenchmarkRunnerService instance.
   *
   * @param sshPool - SSH client pool for remote command execution
   * @param logLevel - Winston log level (default: 'info')
   * @param options - Benchmark runner configuration options
   */
  constructor(
    private readonly sshPool: SSHClientPool,
    logLevel: string = 'info',
    options: BenchmarkRunnerOptions = {},
  ) {
    this.logger = createLogger(logLevel);
    this.options = {
      apiPort: options.apiPort ?? DEFAULT_API_PORT,
      numPrompts: options.numPrompts ?? DEFAULT_NUM_PROMPTS,
      benchmarkTimeoutMs: options.benchmarkTimeoutMs ?? DEFAULT_BENCHMARK_TIMEOUT_MS,
      dataset: options.dataset ?? DEFAULT_DATASET,
      sonnetInputLen: options.sonnetInputLen ?? DEFAULT_SONNET_INPUT_LEN,
      sonnetPrefixLen: options.sonnetPrefixLen ?? DEFAULT_SONNET_PREFIX_LEN,
      randomOutputLen: options.randomOutputLen ?? DEFAULT_RANDOM_OUTPUT_LEN,
      randomInputLen: options.randomInputLen ?? DEFAULT_RANDOM_INPUT_LEN,
      useSudo: options.useSudo ?? false,
    };

    this.logger.info('BenchmarkRunnerService initialized', {
      apiPort: this.options.apiPort,
      numPrompts: this.options.numPrompts,
      benchmarkTimeoutMs: this.options.benchmarkTimeoutMs,
      dataset: this.options.dataset,
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Runs benchmarks at multiple concurrency levels against a deployed vLLM model.
   *
   * For each concurrency level, executes `vllm bench serve` inside the running
   * Docker container via `docker exec`. After all runs complete, evaluates the
   * results against the configured thresholds.
   *
   * @param sshConfig - SSH connection configuration for the target VM
   * @param modelId - HuggingFace model ID of the deployed model
   * @param concurrencyLevels - Array of concurrency levels to test (e.g., [1, 4, 16])
   * @param thresholds - Benchmark threshold configuration for pass/fail evaluation
   * @param containerName - Name of the running vLLM Docker container to exec into
   * @returns Complete benchmark result with metrics and pass/fail status
   */
  async runBenchmarks(
    sshConfig: SSHConfig,
    modelId: string,
    concurrencyLevels: number[],
    thresholds: BenchmarkThresholds,
    containerName?: string,
    parameterCountBillions?: number | null,
  ): Promise<FullBenchmarkResult> {
    this.logger.info(`Starting benchmark suite for model: ${modelId}`, {
      concurrencyLevels,
      numPrompts: this.options.numPrompts,
      containerName: containerName ?? 'none (direct execution)',
    });

    const runs: BenchmarkRunResult[] = [];
    const rawOutputParts: string[] = [];

    for (const concurrency of concurrencyLevels) {
      this.logger.info(`Running benchmark at concurrency level ${concurrency}`, {
        modelId,
      });

      const runResult = await this.runSingleBenchmark(sshConfig, modelId, concurrency, containerName);
      runs.push(runResult);
      rawOutputParts.push(
        `\n=== Concurrency Level: ${concurrency} ===\n${runResult.rawOutput}`,
      );

      if (!runResult.success) {
        this.logger.warn(`Benchmark failed at concurrency ${concurrency}`, {
          modelId,
          error: runResult.error,
        });
      } else {
        this.logger.info(`Benchmark completed at concurrency ${concurrency}`, {
          modelId,
          itlMs: runResult.metrics.itlMs,
          ttftMs: runResult.metrics.ttftMs,
          throughput: runResult.metrics.throughputTokensPerSec,
          p99LatencyMs: runResult.metrics.p99LatencyMs,
          durationMs: runResult.durationMs,
        });
      }
    }

    const combinedRawOutput = rawOutputParts.join('\n');
    const allSucceeded = runs.every((r) => r.success);

    // Evaluate against thresholds (tiered by model size when param count known)
    const rejectionReasons = this.evaluateThresholds(
      runs,
      thresholds,
      parameterCountBillions ?? null,
    );
    const passed = allSucceeded && rejectionReasons.length === 0;

    this.logger.info(`Benchmark suite completed for model: ${modelId}`, {
      allSucceeded,
      passed,
      rejectionReasons,
      totalRuns: runs.length,
      successfulRuns: runs.filter((r) => r.success).length,
    });

    return {
      modelId,
      runs,
      combinedRawOutput,
      allSucceeded,
      rejectionReasons,
      passed,
    };
  }

  /**
   * Runs a single benchmark at a specific concurrency level.
   *
   * @param sshConfig - SSH connection configuration
   * @param modelId - Model ID for logging
   * @param concurrencyLevel - Number of concurrent requests
   * @param containerName - Name of the running vLLM Docker container
   * @returns Result of the single benchmark run
   */
  async runSingleBenchmark(
    sshConfig: SSHConfig,
    modelId: string,
    concurrencyLevel: number,
    containerName?: string,
  ): Promise<BenchmarkRunResult> {
    const command = this.buildBenchmarkCommand(modelId, concurrencyLevel, containerName);

    this.logger.debug(`Executing benchmark command`, {
      command,
      modelId,
      concurrencyLevel,
    });

    let result: CommandResult;
    try {
      result = await this.sshPool.exec(sshConfig, command, {
        timeout: this.options.benchmarkTimeoutMs,
        sudo: this.options.useSudo,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Benchmark command execution failed`, {
        modelId,
        concurrencyLevel,
        error: errorMessage,
      });

      return {
        concurrencyLevel,
        metrics: this.createEmptyMetrics(concurrencyLevel),
        rawOutput: errorMessage,
        durationMs: 0,
        success: false,
        error: `SSH execution failed: ${errorMessage}`,
      };
    }

    // vllm bench serve outputs to both stdout and stderr
    const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');

    if (!result.success) {
      this.logger.warn(`Benchmark command returned non-zero exit code`, {
        modelId,
        concurrencyLevel,
        exitCode: result.exitCode,
        stderr: result.stderr.slice(0, 500),
      });

      // Still try to parse output even on non-zero exit code
      // as vllm bench serve may output metrics to stderr
      const parseResult = parseBenchmarkOutput(combinedOutput, concurrencyLevel);

      if (parseResult.success) {
        return {
          concurrencyLevel,
          metrics: parseResult.metrics,
          rawOutput: combinedOutput,
          durationMs: result.durationMs,
          success: true,
        };
      }

      return {
        concurrencyLevel,
        metrics: this.createEmptyMetrics(concurrencyLevel),
        rawOutput: combinedOutput,
        durationMs: result.durationMs,
        success: false,
        error: `Benchmark exited with code ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
      };
    }

    // Parse the output
    const parseResult = parseBenchmarkOutput(combinedOutput, concurrencyLevel);

    if (!parseResult.success) {
      this.logger.warn(`Failed to parse benchmark output`, {
        modelId,
        concurrencyLevel,
        parseErrors: parseResult.errors,
        outputPreview: combinedOutput.slice(0, 500),
      });

      return {
        concurrencyLevel,
        metrics: this.createEmptyMetrics(concurrencyLevel),
        rawOutput: combinedOutput,
        durationMs: result.durationMs,
        success: false,
        error: `Failed to parse output: ${parseResult.errors.join('; ')}`,
      };
    }

    return {
      concurrencyLevel,
      metrics: parseResult.metrics,
      rawOutput: combinedOutput,
      durationMs: result.durationMs,
      success: true,
    };
  }

  /**
   * Builds the `vllm bench serve` command for a specific concurrency level.
   *
   * When a containerName is provided, the command is wrapped in `docker exec`
   * to run inside the already-running vLLM container. This avoids needing
   * vLLM installed on the host and guarantees version parity between the
   * serving engine and the benchmark client.
   *
   * @param modelId - The model ID (used for the endpoint configuration)
   * @param concurrencyLevel - Number of concurrent requests
   * @param containerName - Name of the running vLLM Docker container
   * @returns The complete shell command string
   */
  buildBenchmarkCommand(modelId: string, concurrencyLevel: number, containerName?: string): string {
    const benchArgs = [
      'vllm bench serve',
      `--base-url http://localhost:${this.options.apiPort}/v1`,
      `--model ${modelId}`,
      `--num-prompts ${this.options.numPrompts}`,
      `--max-concurrency ${concurrencyLevel}`,
      `--random-output-len ${this.options.randomOutputLen}`,
      `--random-input-len ${this.options.randomInputLen}`,
    ].join(' ');

    if (containerName) {
      return `docker exec ${containerName} ${benchArgs}`;
    }

    return benchArgs;
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Evaluates benchmark run results against configured thresholds.
   * Uses tiered ITL thresholds by model size when parameterCountBillions is provided.
   *
   * @param runs - Array of benchmark run results
   * @param thresholds - Threshold configuration
   * @param parameterCountBillions - Model parameter count in billions (for tiered ITL)
   * @returns Array of rejection reason strings (empty if all thresholds pass)
   */
  private evaluateThresholds(
    runs: BenchmarkRunResult[],
    thresholds: BenchmarkThresholds,
    parameterCountBillions: number | null,
  ): string[] {
    const reasons: string[] = [];
    const successfulRuns = runs.filter((r) => r.success);

    if (successfulRuns.length === 0) {
      reasons.push('No successful benchmark runs completed');
      return reasons;
    }

    const maxITLMs = resolveMaxITLMs(thresholds, parameterCountBillions);

    // Evaluate ITL threshold for concurrency=1 (baseline single-user latency)
    const singleUserRun = successfulRuns.find((r) => r.concurrencyLevel === 1);
    if (singleUserRun && singleUserRun.metrics.itlMs > maxITLMs) {
      reasons.push(
        `ITL at concurrency=1 (${singleUserRun.metrics.itlMs.toFixed(2)}ms) exceeds threshold (${maxITLMs}ms)`,
      );
    }

    // Evaluate P99 latency across all concurrency levels
    const maxP99Ms = maxITLMs * 10;
    for (const run of successfulRuns) {
      if (run.metrics.p99LatencyMs > maxP99Ms) {
        reasons.push(
          `P99 latency at concurrency=${run.concurrencyLevel} (${run.metrics.p99LatencyMs.toFixed(2)}ms) exceeds threshold (${maxP99Ms}ms)`,
        );
      }
    }

    // Check that not all runs failed
    const failedRuns = runs.filter((r) => !r.success);
    if (failedRuns.length > 0) {
      const failedLevels = failedRuns.map((r) => r.concurrencyLevel).join(', ');
      reasons.push(`Benchmark failed at concurrency level(s): ${failedLevels}`);
    }

    return reasons;
  }

  /**
   * Creates empty/zero metrics for a failed benchmark run.
   */
  private createEmptyMetrics(concurrencyLevel: number): BenchmarkMetrics {
    return {
      itlMs: 0,
      ttftMs: 0,
      throughputTokensPerSec: 0,
      p99LatencyMs: 0,
      concurrencyLevel,
    };
  }
}
