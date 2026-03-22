import type { SSHConfig, VMHardwareProfile, BenchmarkThresholds } from '../types/config.js';
import type { ModelInfo } from '../types/benchmark.js';
import type { SSHClientPool } from '../services/ssh-client.js';
import type {
  InferenceEngine,
  EngineDeploymentResult,
  EngineFullBenchmarkResult,
} from './engine-types.js';
import { VllmDeploymentService } from '../services/vllm-deployment.js';
import type { VllmDeploymentOptions } from '../services/vllm-deployment.js';
import { BenchmarkRunnerService } from '../services/benchmark-runner.js';
import type { BenchmarkRunnerOptions } from '../services/benchmark-runner.js';
import { createLogger } from '../utils/logger.js';

// ─── VllmEngine Options ──────────────────────────────────────────────────────

/**
 * Configuration options for the VllmEngine adapter.
 * Combines options for deployment and benchmarking.
 */
export interface VllmEngineOptions {
  /** Options for the vLLM deployment service */
  deployment?: VllmDeploymentOptions;
  /** Options for the benchmark runner */
  benchmark?: BenchmarkRunnerOptions;
  /** HuggingFace token for gated model access. Passed through to deployment. */
  huggingfaceToken?: string;
}

// ─── VllmEngine Implementation ───────────────────────────────────────────────

/**
 * vLLM engine adapter implementing the InferenceEngine interface.
 *
 * Wraps the existing VllmDeploymentService and BenchmarkRunnerService
 * to provide a unified engine interface. This adapter translates between
 * the engine-agnostic types and the vLLM-specific implementations.
 *
 * @example
 * ```typescript
 * const engine = new VllmEngine(sshPool, 'info');
 * const deployment = await engine.deploy(sshConfig, model, hardwareProfile);
 * const benchmarks = await engine.runBenchmarks(sshConfig, model.id, [1, 4, 16], thresholds);
 * await engine.stop(sshConfig, deployment.deploymentName);
 * ```
 */
export class VllmEngine implements InferenceEngine {
  readonly engineType = 'vllm' as const;
  private readonly logger;
  private readonly deploymentService: VllmDeploymentService;
  private readonly benchmarkRunner: BenchmarkRunnerService;
  private readonly apiPort: number;

  /**
   * Creates a new VllmEngine instance.
   *
   * @param sshPool - SSH client pool for remote command execution
   * @param logLevel - Winston log level (default: 'info')
   * @param options - Engine configuration options
   */
  constructor(
    sshPool: SSHClientPool,
    logLevel: string = 'info',
    options: VllmEngineOptions = {},
  ) {
    this.logger = createLogger(logLevel);
    this.apiPort = options.deployment?.apiPort ?? 8000;

    const deploymentOpts: VllmDeploymentOptions = {
      ...options.deployment,
      huggingfaceToken: options.huggingfaceToken ?? options.deployment?.huggingfaceToken,
    };
    this.deploymentService = new VllmDeploymentService(
      sshPool,
      logLevel,
      deploymentOpts,
    );

    this.benchmarkRunner = new BenchmarkRunnerService(
      sshPool,
      logLevel,
      {
        ...options.benchmark,
        useSudo: deploymentOpts.useSudo,
      },
    );

    this.logger.info('VllmEngine initialized', {
      engineType: this.engineType,
      apiPort: this.apiPort,
    });
  }

  // ─── InferenceEngine Implementation ──────────────────────────────────────

  /**
   * Deploys a model via vLLM Docker container.
   */
  async deploy(
    sshConfig: SSHConfig,
    model: ModelInfo,
    hardwareProfile: VMHardwareProfile,
  ): Promise<EngineDeploymentResult> {
    this.logger.info(`[vLLM] Deploying model: ${model.id}`);

    const result = await this.deploymentService.deploy(
      sshConfig,
      model,
      hardwareProfile,
    );

    // Map vLLM-specific DeploymentResult to engine-agnostic EngineDeploymentResult
    return {
      deploymentId: result.containerId,
      deploymentName: result.containerName,
      deploymentCommand: result.dockerCommand,
      modelId: result.modelId,
      toolCallParser: result.toolCallParser,
      parallelismConfig: result.tensorParallelSize,
      maxModelLen: result.maxModelLen,
      apiEndpoint: result.apiEndpoint,
      timestamp: result.timestamp,
      engineImage: result.dockerImage,
      healthCheckResult: result.healthCheckResult,
      engineType: 'vllm',
      gpuUtilization: result.gpuUtilization,
    };
  }

  /**
   * Stops a vLLM Docker container by name.
   */
  async stop(sshConfig: SSHConfig, deploymentName: string): Promise<boolean> {
    this.logger.info(`[vLLM] Stopping deployment: ${deploymentName}`);
    return this.deploymentService.stop(sshConfig, deploymentName);
  }

  /**
   * Runs benchmarks using `vllm bench serve` via `docker exec` inside the
   * running vLLM container.
   */
  async runBenchmarks(
    sshConfig: SSHConfig,
    modelId: string,
    concurrencyLevels: number[],
    thresholds: BenchmarkThresholds,
    deploymentName?: string,
    parameterCountBillions?: number | null,
  ): Promise<EngineFullBenchmarkResult> {
    this.logger.info(`[vLLM] Running benchmarks for model: ${modelId}`, {
      containerName: deploymentName ?? 'none (direct execution)',
    });

    const result = await this.benchmarkRunner.runBenchmarks(
      sshConfig,
      modelId,
      concurrencyLevels,
      thresholds,
      deploymentName,
      parameterCountBillions,
    );

    // The BenchmarkRunnerService result already matches our engine types
    return {
      modelId: result.modelId,
      runs: result.runs,
      combinedRawOutput: result.combinedRawOutput,
      allSucceeded: result.allSucceeded,
      rejectionReasons: result.rejectionReasons,
      passed: result.passed,
    };
  }

  /**
   * Resolves the vLLM tool call parser for a model (hermes, mistral, llama3_json).
   */
  resolveToolCallParser(model: ModelInfo): string | null {
    return this.deploymentService.resolveToolCallParser(model);
  }

  /**
   * Returns whether vLLM supports tool calling for this model.
   */
  supportsToolCalling(model: ModelInfo): boolean {
    return this.deploymentService.resolveToolCallParser(model) !== null;
  }

  /**
   * Returns the API port configured for vLLM.
   */
  getApiPort(): number {
    return this.apiPort;
  }

  /**
   * Gets logs from the vLLM Docker container.
   */
  async getDeploymentLogs(
    sshConfig: SSHConfig,
    deploymentName: string,
    tailLines: number = 100,
  ): Promise<string> {
    return this.deploymentService.getContainerLogs(
      sshConfig,
      deploymentName,
      tailLines,
    );
  }

  // ─── Additional vLLM-specific Accessors ──────────────────────────────────

  /**
   * Returns the underlying VllmDeploymentService for advanced usage.
   */
  getDeploymentService(): VllmDeploymentService {
    return this.deploymentService;
  }

  /**
   * Returns the underlying BenchmarkRunnerService for advanced usage.
   */
  getBenchmarkRunner(): BenchmarkRunnerService {
    return this.benchmarkRunner;
  }
}
