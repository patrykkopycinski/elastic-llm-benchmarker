import type { SSHConfig, VMHardwareProfile, BenchmarkThresholds } from '../types/config.js';
import type { ModelInfo, BenchmarkMetrics, GpuUtilization } from '../types/benchmark.js';
import type { SSHClientPool } from '../services/ssh-client.js';
import type { HealthCheckResult } from '../services/health-check.js';

// ─── Engine Type Identifier ──────────────────────────────────────────────────

/**
 * Supported inference engine types.
 * - 'vllm': VLLM (OpenAI-compatible API via Docker)
 * - 'ollama': Ollama (local model serving with simplified setup)
 */
export type EngineType = 'vllm' | 'ollama';

// ─── Engine Deployment Result ────────────────────────────────────────────────

/**
 * Engine-agnostic deployment result.
 *
 * Contains the common information needed after deploying a model
 * via any inference engine, regardless of the underlying implementation.
 */
export interface EngineDeploymentResult {
  /** Unique identifier for the deployment (container ID, process ID, etc.) */
  deploymentId: string;
  /** Human-readable name for the deployment */
  deploymentName: string;
  /** The deployment command or configuration used (for reproducibility) */
  deploymentCommand: string;
  /** The model ID deployed */
  modelId: string;
  /** The tool call parser or method configured (engine-specific) */
  toolCallParser: string;
  /** Parallelism configuration (tensor-parallel for vLLM, GPU layers for Ollama) */
  parallelismConfig: number;
  /** Maximum model length configured/detected */
  maxModelLen: number | null;
  /** The API endpoint URL for inference */
  apiEndpoint: string;
  /** Timestamp of deployment */
  timestamp: string;
  /** Engine-specific image/version identifier */
  engineImage: string;
  /** Health check result with timing and status details */
  healthCheckResult: HealthCheckResult | null;
  /** The engine type used for this deployment */
  engineType: EngineType;
  /** Runtime GPU utilization metrics (vLLM only, null for Ollama) */
  gpuUtilization?: GpuUtilization | null;
}

// ─── Engine Benchmark Result ─────────────────────────────────────────────────

/**
 * Result of a single benchmark run at a given concurrency level.
 * Engine-agnostic — any engine must produce these metrics.
 */
export interface EngineBenchmarkRunResult {
  /** Concurrency level used */
  concurrencyLevel: number;
  /** Parsed benchmark metrics */
  metrics: BenchmarkMetrics;
  /** Raw stdout output from the benchmark tool */
  rawOutput: string;
  /** Duration of the benchmark execution in milliseconds */
  durationMs: number;
  /** Whether the benchmark completed successfully */
  success: boolean;
  /** Error message if the benchmark failed */
  error?: string;
}

/**
 * Complete result from running benchmarks at all concurrency levels.
 * Engine-agnostic wrapper around per-concurrency results.
 */
export interface EngineFullBenchmarkResult {
  /** Model ID that was benchmarked */
  modelId: string;
  /** Results for each concurrency level */
  runs: EngineBenchmarkRunResult[];
  /** Combined raw output from all runs */
  combinedRawOutput: string;
  /** Whether all benchmark runs succeeded */
  allSucceeded: boolean;
  /** Rejection reasons based on threshold violations */
  rejectionReasons: string[];
  /** Whether the benchmark passed all thresholds */
  passed: boolean;
}

// ─── Engine Interface ────────────────────────────────────────────────────────

/**
 * Core engine abstraction interface.
 *
 * Every inference engine (vLLM, Ollama, etc.) must implement this interface
 * to be usable by the benchmark agent. The interface covers the complete
 * model lifecycle:
 *
 * 1. **Deploy**: Set up the model for inference
 * 2. **Health Check**: Wait for the model to become ready
 * 3. **Benchmark**: Run performance tests
 * 4. **Stop**: Tear down the deployment
 *
 * @example
 * ```typescript
 * const engine = engineFactory.create('vllm', sshPool, 'info');
 * const deployment = await engine.deploy(sshConfig, model, hardwareProfile);
 * const benchmarks = await engine.runBenchmarks(sshConfig, model.id, [1, 4, 16], thresholds);
 * await engine.stop(sshConfig, deployment.deploymentName);
 * ```
 */
export interface InferenceEngine {
  /** The engine type identifier */
  readonly engineType: EngineType;

  /**
   * Deploys a model using this engine on a remote VM.
   *
   * Handles the complete deployment lifecycle:
   * 1. Stop any existing deployments
   * 2. Pull/prepare the engine runtime
   * 3. Launch the model with appropriate configuration
   * 4. Wait for health check readiness
   *
   * @param sshConfig - SSH connection configuration for the target VM
   * @param model - The model to deploy
   * @param hardwareProfile - Hardware profile of the target VM
   * @returns Deployment result with endpoint and reproducibility information
   */
  deploy(
    sshConfig: SSHConfig,
    model: ModelInfo,
    hardwareProfile: VMHardwareProfile,
  ): Promise<EngineDeploymentResult>;

  /**
   * Stops a specific deployment by name.
   *
   * @param sshConfig - SSH connection configuration
   * @param deploymentName - Name/identifier of the deployment to stop
   * @returns True if the deployment was stopped, false if it wasn't running
   */
  stop(sshConfig: SSHConfig, deploymentName: string): Promise<boolean>;

  /**
   * Runs benchmarks at multiple concurrency levels against a deployed model.
   *
   * @param sshConfig - SSH connection configuration for the target VM
   * @param modelId - HuggingFace model ID of the deployed model
   * @param concurrencyLevels - Array of concurrency levels to test
   * @param thresholds - Benchmark threshold configuration for pass/fail evaluation
   * @param deploymentName - Optional deployment name (container/process) for engines
   *                         that run benchmarks inside the deployment runtime
   * @param parameterCountBillions - Model parameter count in billions (for tiered ITL thresholds)
   * @returns Complete benchmark result with metrics and pass/fail status
   */
  runBenchmarks(
    sshConfig: SSHConfig,
    modelId: string,
    concurrencyLevels: number[],
    thresholds: BenchmarkThresholds,
    deploymentName?: string,
    parameterCountBillions?: number | null,
  ): Promise<EngineFullBenchmarkResult>;

  /**
   * Resolves the appropriate tool call configuration for a model.
   *
   * @param model - The model to resolve tool calling for
   * @returns Tool call parser/method name, or null if not supported
   */
  resolveToolCallParser(model: ModelInfo): string | null;

  /**
   * Returns whether this engine supports tool calling for a given model.
   *
   * @param model - The model to check
   * @returns True if the engine supports tool calling for this model
   */
  supportsToolCalling(model: ModelInfo): boolean;

  /**
   * Returns the API port used by this engine.
   */
  getApiPort(): number;

  /**
   * Gets logs from the running deployment.
   *
   * @param sshConfig - SSH connection configuration
   * @param deploymentName - Name of the deployment
   * @param tailLines - Number of tail lines to retrieve
   * @returns Log output string
   */
  getDeploymentLogs(
    sshConfig: SSHConfig,
    deploymentName: string,
    tailLines?: number,
  ): Promise<string>;
}

// ─── Engine Factory Options ──────────────────────────────────────────────────

/**
 * Options for creating an engine instance via the factory.
 */
export interface EngineFactoryOptions {
  /** Engine type to create */
  engineType: EngineType;
  /** SSH client pool for remote command execution */
  sshPool: SSHClientPool;
  /** Log level (default: 'info') */
  logLevel?: string;
  /** Engine-specific options (passed through to the engine constructor) */
  engineOptions?: Record<string, unknown>;
}
