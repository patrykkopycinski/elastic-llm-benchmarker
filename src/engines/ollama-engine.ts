import type { SSHConfig, VMHardwareProfile, BenchmarkThresholds } from '../types/config.js';
import type { ModelInfo } from '../types/benchmark.js';
import type { SSHClientPool } from '../services/ssh-client.js';
import type {
  InferenceEngine,
  EngineDeploymentResult,
  EngineFullBenchmarkResult,
} from './engine-types.js';
import { OllamaDeploymentService } from '../services/ollama-deployment.js';
import type { OllamaDeploymentOptions } from '../services/ollama-deployment.js';
import { OllamaBenchmarkRunnerService } from '../services/ollama-benchmark-runner.js';
import type { OllamaBenchmarkRunnerOptions } from '../services/ollama-benchmark-runner.js';
import { createLogger } from '../utils/logger.js';

// ─── OllamaEngine Options ────────────────────────────────────────────────────

/**
 * Configuration options for the OllamaEngine adapter.
 * Combines options for deployment and benchmarking.
 */
export interface OllamaEngineOptions {
  /** Options for the Ollama deployment service */
  deployment?: OllamaDeploymentOptions;
  /** Options for the Ollama benchmark runner */
  benchmark?: OllamaBenchmarkRunnerOptions;
}

// ─── OllamaEngine Implementation ─────────────────────────────────────────────

/**
 * Ollama engine adapter implementing the InferenceEngine interface.
 *
 * Wraps the OllamaDeploymentService and OllamaBenchmarkRunnerService
 * to provide a unified engine interface. Ollama provides an alternative
 * inference engine with:
 *
 * **Advantages over vLLM:**
 * - Simpler setup (single binary or Docker container)
 * - Built-in model management (pull, run, stop)
 * - Lower resource overhead for smaller models
 *
 * **Limitations (from evaluation findings):**
 * - Tool calling only works reliably with Qwen2.5 models
 * - No native benchmarking tools (requires custom HTTP-based benchmarks)
 * - Less mature tensor parallelism support
 * - Different API format (not directly OpenAI-compatible without adapter)
 *
 * @example
 * ```typescript
 * const engine = new OllamaEngine(sshPool, 'info');
 * const deployment = await engine.deploy(sshConfig, model, hardwareProfile);
 * const benchmarks = await engine.runBenchmarks(sshConfig, model.id, [1, 4], thresholds);
 * await engine.stop(sshConfig, deployment.deploymentName);
 * ```
 */
export class OllamaEngine implements InferenceEngine {
  readonly engineType = 'ollama' as const;
  private readonly logger;
  private readonly deploymentService: OllamaDeploymentService;
  private readonly benchmarkRunner: OllamaBenchmarkRunnerService;
  private readonly apiPort: number;

  /**
   * Creates a new OllamaEngine instance.
   *
   * @param sshPool - SSH client pool for remote command execution
   * @param logLevel - Winston log level (default: 'info')
   * @param options - Engine configuration options
   */
  constructor(
    sshPool: SSHClientPool,
    logLevel: string = 'info',
    options: OllamaEngineOptions = {},
  ) {
    this.logger = createLogger(logLevel);
    this.apiPort = options.deployment?.apiPort ?? 11434;

    this.deploymentService = new OllamaDeploymentService(
      sshPool,
      logLevel,
      options.deployment,
    );

    this.benchmarkRunner = new OllamaBenchmarkRunnerService(
      sshPool,
      logLevel,
      options.benchmark,
    );

    this.logger.info('OllamaEngine initialized', {
      engineType: this.engineType,
      apiPort: this.apiPort,
    });
  }

  // ─── InferenceEngine Implementation ──────────────────────────────────────

  /**
   * Deploys a model via Ollama.
   */
  async deploy(
    sshConfig: SSHConfig,
    model: ModelInfo,
    hardwareProfile: VMHardwareProfile,
  ): Promise<EngineDeploymentResult> {
    this.logger.info(`[Ollama] Deploying model: ${model.id}`);

    const result = await this.deploymentService.deploy(
      sshConfig,
      model,
      hardwareProfile,
    );

    // Map Ollama-specific result to engine-agnostic EngineDeploymentResult
    return {
      deploymentId: result.deploymentId,
      deploymentName: result.deploymentName,
      deploymentCommand: result.deploymentCommand,
      modelId: result.modelId,
      toolCallParser: result.toolCallMethod,
      parallelismConfig: result.numGpuLayers,
      maxModelLen: result.numCtx,
      apiEndpoint: result.apiEndpoint,
      timestamp: result.timestamp,
      engineImage: result.ollamaImage,
      healthCheckResult: result.healthCheckResult,
      engineType: 'ollama',
    };
  }

  /**
   * Stops an Ollama deployment.
   */
  async stop(sshConfig: SSHConfig, deploymentName: string): Promise<boolean> {
    this.logger.info(`[Ollama] Stopping deployment: ${deploymentName}`);
    return this.deploymentService.stop(sshConfig, deploymentName);
  }

  /**
   * Runs benchmarks using the Ollama HTTP-based benchmark runner.
   */
  async runBenchmarks(
    sshConfig: SSHConfig,
    modelId: string,
    concurrencyLevels: number[],
    thresholds: BenchmarkThresholds,
    _deploymentName?: string,
    parameterCountBillions?: number | null,
  ): Promise<EngineFullBenchmarkResult> {
    this.logger.info(`[Ollama] Running benchmarks for model: ${modelId}`);

    // Resolve the Ollama model name from the model ID
    const ollamaModelName = this.resolveOllamaModelNameFromId(modelId);

    const result = await this.benchmarkRunner.runBenchmarks(
      sshConfig,
      ollamaModelName,
      concurrencyLevels,
      thresholds,
      parameterCountBillions,
    );

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
   * Resolves Ollama tool call method for a model.
   *
   * Only Qwen2.5 models have reliable tool calling in Ollama.
   */
  resolveToolCallParser(model: ModelInfo): string | null {
    return this.deploymentService.resolveToolCallMethod(model);
  }

  /**
   * Returns whether Ollama supports tool calling for this model.
   *
   * Based on evaluation findings, only Qwen2.5 models work reliably.
   */
  supportsToolCalling(model: ModelInfo): boolean {
    return this.deploymentService.resolveToolCallMethod(model) !== null;
  }

  /**
   * Returns the API port configured for Ollama.
   */
  getApiPort(): number {
    return this.apiPort;
  }

  /**
   * Gets logs from the Ollama deployment.
   */
  async getDeploymentLogs(
    sshConfig: SSHConfig,
    deploymentName: string,
    tailLines: number = 100,
  ): Promise<string> {
    return this.deploymentService.getServiceLogs(
      sshConfig,
      deploymentName,
      tailLines,
    );
  }

  // ─── Additional Ollama-specific Accessors ────────────────────────────────

  /**
   * Returns the underlying OllamaDeploymentService for advanced usage.
   */
  getDeploymentService(): OllamaDeploymentService {
    return this.deploymentService;
  }

  /**
   * Returns the underlying OllamaBenchmarkRunnerService for advanced usage.
   */
  getBenchmarkRunner(): OllamaBenchmarkRunnerService {
    return this.benchmarkRunner;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Resolves an Ollama model name from a HuggingFace model ID.
   * This is a simplified version that extracts common patterns.
   */
  private resolveOllamaModelNameFromId(modelId: string): string {
    const lowerId = modelId.toLowerCase();

    // Common HuggingFace → Ollama mappings
    if (lowerId.includes('qwen')) {
      const sizeMatch = lowerId.match(/(\d+)[bB]/);
      const size = sizeMatch ? `:${sizeMatch[1]}b` : '';
      if (lowerId.includes('qwen2.5')) return `qwen2.5${size}`;
      if (lowerId.includes('qwen2')) return `qwen2${size}`;
      return `qwen${size}`;
    }

    if (lowerId.includes('llama')) {
      const sizeMatch = lowerId.match(/(\d+)[bB]/);
      const size = sizeMatch ? `:${sizeMatch[1]}b` : '';
      if (lowerId.includes('llama-3.2') || lowerId.includes('llama3.2')) return `llama3.2${size}`;
      if (lowerId.includes('llama-3.1') || lowerId.includes('llama3.1')) return `llama3.1${size}`;
      if (lowerId.includes('llama-3') || lowerId.includes('llama3')) return `llama3${size}`;
      return `llama${size}`;
    }

    if (lowerId.includes('mistral')) return 'mistral';
    if (lowerId.includes('mixtral')) return 'mixtral';
    if (lowerId.includes('gemma')) return 'gemma2';

    // Fallback: use model ID as-is
    return modelId;
  }
}
