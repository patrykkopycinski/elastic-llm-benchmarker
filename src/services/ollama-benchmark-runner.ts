import type { SSHConfig, BenchmarkThresholds } from '../types/config.js';
import { resolveMaxITLMs } from '../types/config.js';
import type { BenchmarkMetrics } from '../types/benchmark.js';
import type { SSHClientPool, CommandResult } from './ssh-client.js';
import { createLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Configuration options for the Ollama benchmark runner */
export interface OllamaBenchmarkRunnerOptions {
  /** Port where the Ollama API is running (default: 11434) */
  apiPort?: number;
  /** Number of prompts to generate per benchmark run (default: 100) */
  numPrompts?: number;
  /** Timeout in milliseconds per concurrency-level benchmark (default: 600000 = 10 min) */
  benchmarkTimeoutMs?: number;
  /** Input token count for each prompt (default: 256) */
  inputTokens?: number;
  /** Maximum output tokens per request (default: 128) */
  maxOutputTokens?: number;
}

/** Result of a single Ollama benchmark run at a given concurrency level */
export interface OllamaBenchmarkRunResult {
  /** Concurrency level used */
  concurrencyLevel: number;
  /** Parsed benchmark metrics */
  metrics: BenchmarkMetrics;
  /** Raw stdout output from the benchmark */
  rawOutput: string;
  /** Duration of the benchmark execution in milliseconds */
  durationMs: number;
  /** Whether the benchmark completed successfully */
  success: boolean;
  /** Error message if the benchmark failed */
  error?: string;
}

/** Complete result from running benchmarks at all concurrency levels */
export interface OllamaFullBenchmarkResult {
  /** Model ID that was benchmarked */
  modelId: string;
  /** Results for each concurrency level */
  runs: OllamaBenchmarkRunResult[];
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

const DEFAULT_API_PORT = 11434;
const DEFAULT_NUM_PROMPTS = 100;
const DEFAULT_BENCHMARK_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_INPUT_TOKENS = 256;
const DEFAULT_MAX_OUTPUT_TOKENS = 128;

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Error thrown when an Ollama benchmark execution fails */
export class OllamaBenchmarkRunnerError extends Error {
  constructor(
    message: string,
    public readonly modelId: string,
    public readonly concurrencyLevel: number,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'OllamaBenchmarkRunnerError';
  }
}

// ─── Ollama Benchmark Runner Service ──────────────────────────────────────────

/**
 * Service for running benchmarks against Ollama-deployed models.
 *
 * Since Ollama does not have a native `bench serve` command like vLLM,
 * this service uses HTTP-based benchmarking through the Ollama API.
 * It sends concurrent requests via a shell-based approach and measures:
 * - ITL (Inter-Token Latency)
 * - TTFT (Time To First Token)
 * - Throughput (tokens/sec)
 * - P99 latencies
 *
 * The benchmarking script is deployed and executed on the remote VM
 * via SSH, using the Ollama /api/generate endpoint.
 *
 * @example
 * ```typescript
 * const runner = new OllamaBenchmarkRunnerService(sshPool, 'info');
 * const result = await runner.runBenchmarks(
 *   sshConfig,
 *   'qwen2.5:7b',
 *   [1, 4, 16],
 *   thresholds,
 * );
 * console.log(`Passed: ${result.passed}`);
 * ```
 */
export class OllamaBenchmarkRunnerService {
  private readonly logger;
  private readonly options: Required<OllamaBenchmarkRunnerOptions>;

  /**
   * Creates a new OllamaBenchmarkRunnerService instance.
   *
   * @param sshPool - SSH client pool for remote command execution
   * @param logLevel - Winston log level (default: 'info')
   * @param options - Benchmark runner configuration options
   */
  constructor(
    private readonly sshPool: SSHClientPool,
    logLevel: string = 'info',
    options: OllamaBenchmarkRunnerOptions = {},
  ) {
    this.logger = createLogger(logLevel);
    this.options = {
      apiPort: options.apiPort ?? DEFAULT_API_PORT,
      numPrompts: options.numPrompts ?? DEFAULT_NUM_PROMPTS,
      benchmarkTimeoutMs: options.benchmarkTimeoutMs ?? DEFAULT_BENCHMARK_TIMEOUT_MS,
      inputTokens: options.inputTokens ?? DEFAULT_INPUT_TOKENS,
      maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };

    this.logger.info('OllamaBenchmarkRunnerService initialized', {
      apiPort: this.options.apiPort,
      numPrompts: this.options.numPrompts,
      benchmarkTimeoutMs: this.options.benchmarkTimeoutMs,
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Runs benchmarks at multiple concurrency levels against an Ollama model.
   *
   * @param sshConfig - SSH connection configuration
   * @param modelId - Ollama model name
   * @param concurrencyLevels - Array of concurrency levels to test
   * @param thresholds - Benchmark threshold configuration
   * @returns Complete benchmark result
   */
  async runBenchmarks(
    sshConfig: SSHConfig,
    modelId: string,
    concurrencyLevels: number[],
    thresholds: BenchmarkThresholds,
    parameterCountBillions?: number | null,
  ): Promise<OllamaFullBenchmarkResult> {
    this.logger.info(`Starting Ollama benchmark suite for model: ${modelId}`, {
      concurrencyLevels,
      numPrompts: this.options.numPrompts,
    });

    const runs: OllamaBenchmarkRunResult[] = [];
    const rawOutputParts: string[] = [];

    for (const concurrency of concurrencyLevels) {
      this.logger.info(`Running Ollama benchmark at concurrency level ${concurrency}`, {
        modelId,
      });

      const runResult = await this.runSingleBenchmark(sshConfig, modelId, concurrency);
      runs.push(runResult);
      rawOutputParts.push(
        `\n=== Concurrency Level: ${concurrency} ===\n${runResult.rawOutput}`,
      );

      if (!runResult.success) {
        this.logger.warn(`Ollama benchmark failed at concurrency ${concurrency}`, {
          modelId,
          error: runResult.error,
        });
      } else {
        this.logger.info(`Ollama benchmark completed at concurrency ${concurrency}`, {
          modelId,
          itlMs: runResult.metrics.itlMs,
          ttftMs: runResult.metrics.ttftMs,
          throughput: runResult.metrics.throughputTokensPerSec,
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

    this.logger.info(`Ollama benchmark suite completed for model: ${modelId}`, {
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
   * Uses a Python script deployed via SSH to send concurrent requests
   * to the Ollama API and measure performance metrics.
   *
   * @param sshConfig - SSH connection configuration
   * @param modelId - Ollama model name
   * @param concurrencyLevel - Number of concurrent requests
   * @returns Result of the single benchmark run
   */
  async runSingleBenchmark(
    sshConfig: SSHConfig,
    modelId: string,
    concurrencyLevel: number,
  ): Promise<OllamaBenchmarkRunResult> {
    const benchmarkScript = this.buildBenchmarkScript(modelId, concurrencyLevel);

    this.logger.debug(`Executing Ollama benchmark script`, {
      modelId,
      concurrencyLevel,
    });

    let result: CommandResult;
    try {
      result = await this.sshPool.exec(sshConfig, benchmarkScript, {
        timeout: this.options.benchmarkTimeoutMs,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Ollama benchmark execution failed`, {
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

    const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');

    if (!result.success) {
      this.logger.warn(`Ollama benchmark returned non-zero exit code`, {
        modelId,
        concurrencyLevel,
        exitCode: result.exitCode,
      });

      // Try to parse output even on failure
      const parsedMetrics = this.parseOllamaBenchmarkOutput(combinedOutput, concurrencyLevel);
      if (parsedMetrics) {
        return {
          concurrencyLevel,
          metrics: parsedMetrics,
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
    const parsedMetrics = this.parseOllamaBenchmarkOutput(combinedOutput, concurrencyLevel);

    if (!parsedMetrics) {
      this.logger.warn(`Failed to parse Ollama benchmark output`, {
        modelId,
        concurrencyLevel,
        outputPreview: combinedOutput.slice(0, 500),
      });

      return {
        concurrencyLevel,
        metrics: this.createEmptyMetrics(concurrencyLevel),
        rawOutput: combinedOutput,
        durationMs: result.durationMs,
        success: false,
        error: `Failed to parse benchmark output`,
      };
    }

    return {
      concurrencyLevel,
      metrics: parsedMetrics,
      rawOutput: combinedOutput,
      durationMs: result.durationMs,
      success: true,
    };
  }

  /**
   * Builds a shell-based benchmark script that uses the Ollama API.
   *
   * The script:
   * 1. Generates a test prompt of the configured length
   * 2. Sends concurrent requests to the Ollama generate endpoint
   * 3. Measures TTFT, ITL, throughput, and latency
   * 4. Outputs structured results in a parseable format
   *
   * @param modelId - Ollama model name
   * @param concurrencyLevel - Number of concurrent requests
   * @returns Shell command to execute the benchmark
   */
  buildBenchmarkScript(modelId: string, concurrencyLevel: number): string {
    // Use a Python one-liner to run the benchmark since it handles
    // concurrency and timing more reliably than shell scripts
    const script = `python3 -c "
import asyncio, aiohttp, json, time, statistics, sys

async def benchmark():
    url = 'http://localhost:${this.options.apiPort}/api/generate'
    prompt = 'Explain the theory of relativity in detail. ' * ${Math.ceil(this.options.inputTokens / 10)}
    prompt = prompt[:${this.options.inputTokens * 4}]  # Approximate token count

    ttfts = []
    itls = []
    latencies = []
    total_tokens = 0
    errors = 0

    async def run_request(session, req_id):
        nonlocal total_tokens, errors
        payload = {
            'model': '${modelId}',
            'prompt': prompt,
            'stream': True,
            'options': {
                'num_predict': ${this.options.maxOutputTokens}
            }
        }
        tokens_in_request = 0
        token_times = []

        try:
            start = time.monotonic()
            first_token_time = None

            async with session.post(url, json=payload) as resp:
                if resp.status != 200:
                    errors += 1
                    return

                async for line in resp.content:
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                        now = time.monotonic()

                        if first_token_time is None:
                            first_token_time = now
                            ttfts.append((first_token_time - start) * 1000)
                        else:
                            token_times.append(now)

                        if data.get('response'):
                            tokens_in_request += 1

                        if data.get('done'):
                            break
                    except json.JSONDecodeError:
                        continue

            end = time.monotonic()
            latencies.append((end - start) * 1000)
            total_tokens += tokens_in_request

            # Calculate per-token latencies
            if len(token_times) > 1:
                for i in range(1, len(token_times)):
                    itls.append((token_times[i] - token_times[i-1]) * 1000)

        except Exception as e:
            errors += 1

    total_start = time.monotonic()
    num_batches = max(1, ${this.options.numPrompts} // ${concurrencyLevel})

    async with aiohttp.ClientSession() as session:
        for batch in range(num_batches):
            tasks = [run_request(session, i + batch * ${concurrencyLevel})
                     for i in range(${concurrencyLevel})]
            await asyncio.gather(*tasks)

    total_duration = time.monotonic() - total_start

    # Calculate metrics
    mean_ttft = statistics.mean(ttfts) if ttfts else 0
    mean_itl = statistics.mean(itls) if itls else 0
    throughput = total_tokens / total_duration if total_duration > 0 else 0
    p99_latency = sorted(latencies)[int(len(latencies) * 0.99)] if latencies else 0

    # Output in structured format
    print('============ Ollama Benchmark Result ============')
    print(f'Successful requests:                     {len(latencies)}')
    print(f'Failed requests:                         {errors}')
    print(f'Benchmark duration (s):                  {total_duration:.2f}')
    print(f'Total generated tokens:                  {total_tokens}')
    print(f'Output token throughput (tok/s):          {throughput:.1f}')
    print(f'Mean TTFT (ms):                          {mean_ttft:.2f}')
    print(f'Mean ITL (ms):                           {mean_itl:.2f}')
    print(f'P99 Latency (ms):                        {p99_latency:.2f}')
    print('==================================================')

asyncio.run(benchmark())
"`;

    return script;
  }

  /**
   * Parses the structured output from our Ollama benchmark script.
   *
   * @param output - Raw benchmark output
   * @param concurrencyLevel - The concurrency level used
   * @returns Parsed benchmark metrics, or null if parsing fails
   */
  parseOllamaBenchmarkOutput(output: string, concurrencyLevel: number): BenchmarkMetrics | null {
    try {
      const ttftMatch = output.match(/Mean TTFT \(ms\):\s+([\d.]+)/);
      const itlMatch = output.match(/Mean ITL \(ms\):\s+([\d.]+)/);
      const throughputMatch = output.match(/Output token throughput \(tok\/s\):\s+([\d.]+)/);
      const p99Match = output.match(/P99 Latency \(ms\):\s+([\d.]+)/);

      if (!ttftMatch || !itlMatch || !throughputMatch || !p99Match) {
        return null;
      }

      return {
        ttftMs: parseFloat(ttftMatch[1]!),
        itlMs: parseFloat(itlMatch[1]!),
        throughputTokensPerSec: parseFloat(throughputMatch[1]!),
        p99LatencyMs: parseFloat(p99Match[1]!),
        concurrencyLevel,
      };
    } catch {
      return null;
    }
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Evaluates benchmark run results against configured thresholds.
   * Uses tiered ITL thresholds by model size when parameterCountBillions is provided.
   */
  private evaluateThresholds(
    runs: OllamaBenchmarkRunResult[],
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

    // Evaluate ITL threshold for concurrency=1
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
