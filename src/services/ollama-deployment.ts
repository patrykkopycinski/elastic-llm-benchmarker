import type { SSHConfig, VMHardwareProfile } from '../types/config.js';
import type { ModelInfo } from '../types/benchmark.js';
import type { SSHClientPool, CommandResult } from './ssh-client.js';
import type { HealthCheckResult } from './health-check.js';
import { createLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Configuration options for the Ollama deployment service */
export interface OllamaDeploymentOptions {
  /** Port to expose for the Ollama API (default: 11434) */
  apiPort?: number;
  /** Timeout in milliseconds for model pull (default: 1200000 = 20 min) */
  pullTimeoutMs?: number;
  /** Timeout in milliseconds for Ollama service start (default: 30000 = 30 sec) */
  startTimeoutMs?: number;
  /** Timeout in milliseconds for health check readiness (default: 300000 = 5 min) */
  healthCheckTimeoutMs?: number;
  /** Interval in milliseconds between health check attempts (default: 5000 = 5 sec) */
  healthCheckIntervalMs?: number;
  /** Number of GPU layers to offload (-1 = all, default: -1) */
  numGpuLayers?: number;
  /** Context window size override (optional, Ollama auto-detects) */
  numCtx?: number;
  /** Whether to use Docker for Ollama deployment (default: false, uses system install) */
  useDocker?: boolean;
  /** Docker image for Ollama (default: 'ollama/ollama:latest') */
  dockerImage?: string;
}

/** Result of a successful Ollama deployment */
export interface OllamaDeploymentResult {
  /** Deployment identifier (container ID or 'system-service') */
  deploymentId: string;
  /** The deployment name for management */
  deploymentName: string;
  /** The exact command used for deployment (for reproducibility) */
  deploymentCommand: string;
  /** The model ID deployed */
  modelId: string;
  /** The Ollama model name (may differ from HuggingFace ID) */
  ollamaModelName: string;
  /** Tool call method configured */
  toolCallMethod: string;
  /** Number of GPU layers offloaded */
  numGpuLayers: number;
  /** Context window size */
  numCtx: number | null;
  /** The API endpoint URL */
  apiEndpoint: string;
  /** Timestamp of deployment */
  timestamp: string;
  /** Ollama version or Docker image */
  ollamaImage: string;
  /** Health check result */
  healthCheckResult: HealthCheckResult | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_API_PORT = 11434;
const DEFAULT_PULL_TIMEOUT_MS = 1_200_000; // 20 minutes
const DEFAULT_START_TIMEOUT_MS = 30_000; // 30 seconds
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5_000; // 5 seconds
const DEFAULT_NUM_GPU_LAYERS = -1; // All layers on GPU
const DEFAULT_DOCKER_IMAGE = 'ollama/ollama:latest';

/**
 * Ollama tool calling support by model family.
 *
 * Based on evaluation findings:
 * - Qwen2.5 is the only model family with reliable tool calling in Ollama
 * - Other families may work with varying degrees of reliability
 */
const OLLAMA_TOOL_CALL_SUPPORT: Record<string, string> = {
  qwen: 'native',
  qwen2: 'native',
  qwen2_moe: 'native',
};

/**
 * Mapping from HuggingFace model IDs/architectures to Ollama model names.
 * Ollama uses its own naming convention for models.
 */
const HUGGINGFACE_TO_OLLAMA_NAMES: Record<string, string> = {
  'qwen/qwen2.5': 'qwen2.5',
  'meta-llama/llama-3': 'llama3',
  'meta-llama/llama-3.1': 'llama3.1',
  'meta-llama/llama-3.2': 'llama3.2',
  'mistralai/mistral': 'mistral',
  'mistralai/mixtral': 'mixtral',
  'google/gemma': 'gemma',
  'google/gemma2': 'gemma2',
  'deepseek-ai/deepseek': 'deepseek-r1',
};

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Base error class for Ollama deployment operations */
export class OllamaDeploymentError extends Error {
  constructor(
    message: string,
    public readonly modelId: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'OllamaDeploymentError';
  }
}

/** Error thrown when Ollama model pull fails */
export class OllamaModelPullError extends OllamaDeploymentError {
  constructor(modelId: string, cause?: Error) {
    super(
      `Ollama model pull failed for ${modelId}: ${cause?.message ?? 'unknown error'}`,
      modelId,
      cause,
    );
    this.name = 'OllamaModelPullError';
  }
}

/** Error thrown when Ollama service fails to start */
export class OllamaServiceError extends OllamaDeploymentError {
  constructor(modelId: string, operation: string, cause?: Error) {
    super(
      `Ollama ${operation} failed for ${modelId}: ${cause?.message ?? 'unknown error'}`,
      modelId,
      cause,
    );
    this.name = 'OllamaServiceError';
  }
}

// ─── Ollama Deployment Service ────────────────────────────────────────────────

/**
 * Service for deploying LLM models via Ollama on remote VMs.
 *
 * Supports two deployment modes:
 * 1. **System service** (default): Uses Ollama installed on the host system
 * 2. **Docker**: Uses Ollama Docker image with GPU passthrough
 *
 * Handles the complete deployment lifecycle:
 * 1. Ensure Ollama service is running
 * 2. Pull the requested model
 * 3. Load the model into memory
 * 4. Wait for health check readiness
 * 5. Store the deployment configuration for reproducibility
 *
 * **Important limitations from evaluation findings:**
 * - Tool calling only reliably works with Qwen2.5 models
 * - Context window handling differs from vLLM
 * - No native benchmark tooling (uses custom HTTP-based benchmarks)
 *
 * @example
 * ```typescript
 * const sshPool = new SSHClientPool();
 * const deployer = new OllamaDeploymentService(sshPool, 'info');
 *
 * const result = await deployer.deploy(sshConfig, model, hardwareProfile);
 * console.log(`Deployed at: ${result.apiEndpoint}`);
 *
 * await deployer.stop(sshConfig, result.deploymentName);
 * ```
 */
export class OllamaDeploymentService {
  private readonly logger;
  private readonly options: Required<
    Omit<OllamaDeploymentOptions, 'numCtx'>
  > & { numCtx: number | null };

  /**
   * Creates a new OllamaDeploymentService instance.
   *
   * @param sshPool - SSH client pool for remote command execution
   * @param logLevel - Winston log level (default: 'info')
   * @param options - Deployment configuration options
   */
  constructor(
    private readonly sshPool: SSHClientPool,
    logLevel: string = 'info',
    options: OllamaDeploymentOptions = {},
  ) {
    this.logger = createLogger(logLevel);
    this.options = {
      apiPort: options.apiPort ?? DEFAULT_API_PORT,
      pullTimeoutMs: options.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS,
      startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      healthCheckTimeoutMs: options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
      healthCheckIntervalMs: options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS,
      numGpuLayers: options.numGpuLayers ?? DEFAULT_NUM_GPU_LAYERS,
      numCtx: options.numCtx ?? null,
      useDocker: options.useDocker ?? false,
      dockerImage: options.dockerImage ?? DEFAULT_DOCKER_IMAGE,
    };

    this.logger.info('OllamaDeploymentService initialized', {
      apiPort: this.options.apiPort,
      useDocker: this.options.useDocker,
      numGpuLayers: this.options.numGpuLayers,
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Deploys a model via Ollama on a remote VM.
   *
   * @param sshConfig - SSH connection configuration for the target VM
   * @param model - The model to deploy
   * @param _hardwareProfile - Hardware profile (used for GPU layer config)
   * @returns Deployment result with endpoint details
   */
  async deploy(
    sshConfig: SSHConfig,
    model: ModelInfo,
    _hardwareProfile: VMHardwareProfile,
  ): Promise<OllamaDeploymentResult> {
    const ollamaModelName = this.resolveOllamaModelName(model);
    const deploymentName = `ollama-${ollamaModelName.replace(/[/:]/g, '-')}`;

    this.logger.info(`Starting Ollama deployment of model: ${model.id}`, {
      ollamaModelName,
      deploymentName,
      useDocker: this.options.useDocker,
    });

    // Step 1: Ensure Ollama service is running
    await this.ensureOllamaRunning(sshConfig, model.id);

    // Step 2: Pull the model
    await this.pullModel(sshConfig, ollamaModelName, model.id);

    // Step 3: Load the model into memory with configuration
    const loadCommand = this.buildLoadCommand(ollamaModelName);
    await this.loadModel(sshConfig, ollamaModelName, loadCommand, model.id);

    // Step 4: Wait for the model to be ready
    const healthCheckResult = await this.waitForModelReady(
      sshConfig,
      ollamaModelName,
      model.id,
    );

    const apiEndpoint = `http://${sshConfig.host}:${this.options.apiPort}`;
    const toolCallMethod = this.resolveToolCallMethod(model);

    const deploymentCommand = this.buildDeploymentSummary(
      ollamaModelName,
      loadCommand,
    );

    const result: OllamaDeploymentResult = {
      deploymentId: this.options.useDocker ? 'ollama-container' : 'system-service',
      deploymentName,
      deploymentCommand,
      modelId: model.id,
      ollamaModelName,
      toolCallMethod: toolCallMethod ?? '',
      numGpuLayers: this.options.numGpuLayers,
      numCtx: this.options.numCtx,
      apiEndpoint,
      timestamp: new Date().toISOString(),
      ollamaImage: this.options.useDocker ? this.options.dockerImage : 'system',
      healthCheckResult,
    };

    this.logger.info(`Ollama deployment successful: ${model.id}`, {
      ollamaModelName,
      apiEndpoint,
      toolCallMethod,
    });

    return result;
  }

  /**
   * Stops an Ollama model deployment.
   * Unloads the model from memory and optionally stops the Docker container.
   *
   * @param sshConfig - SSH connection configuration
   * @param deploymentName - Name of the deployment to stop
   * @returns True if the deployment was stopped, false otherwise
   */
  async stop(sshConfig: SSHConfig, deploymentName: string): Promise<boolean> {
    this.logger.info(`Stopping Ollama deployment: ${deploymentName}`);

    try {
      // Extract model name from deployment name (ollama-<model-name>)
      const modelName = deploymentName.replace(/^ollama-/, '').replace(/-/g, ':');

      // Unload model by sending a generate request with keep_alive: 0
      const unloadResult = await this.execSSH(
        sshConfig,
        `curl -sf -X POST http://localhost:${this.options.apiPort}/api/generate -d '{"model":"${modelName}","keep_alive":0}'`,
        this.options.startTimeoutMs,
      );

      if (this.options.useDocker) {
        // Stop Docker container
        await this.execSSH(
          sshConfig,
          'docker stop ollama-server && docker rm ollama-server',
          this.options.startTimeoutMs,
        );
      }

      this.logger.info(`Ollama deployment stopped: ${deploymentName}`);
      return unloadResult.success;
    } catch (error) {
      this.logger.warn(`Failed to stop Ollama deployment: ${deploymentName}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Gets logs from the Ollama service.
   *
   * @param sshConfig - SSH connection configuration
   * @param _deploymentName - Deployment name (unused, Ollama has a single log)
   * @param tailLines - Number of tail lines to retrieve (default: 100)
   * @returns Log output
   */
  async getServiceLogs(
    sshConfig: SSHConfig,
    _deploymentName: string,
    tailLines: number = 100,
  ): Promise<string> {
    if (this.options.useDocker) {
      const result = await this.execSSH(
        sshConfig,
        `docker logs --tail ${tailLines} ollama-server 2>&1`,
        this.options.startTimeoutMs,
      );
      return result.stdout;
    }

    // System service: check journalctl
    const result = await this.execSSH(
      sshConfig,
      `journalctl -u ollama --no-pager -n ${tailLines} 2>&1 || tail -n ${tailLines} /var/log/ollama.log 2>&1`,
      this.options.startTimeoutMs,
    );
    return result.stdout;
  }

  /**
   * Resolves the Ollama model name from a HuggingFace model.
   *
   * Ollama uses its own naming convention (e.g., "qwen2.5:7b" instead of
   * "Qwen/Qwen2.5-7B-Instruct"). This method attempts to map between them.
   *
   * @param model - The HuggingFace model info
   * @returns The Ollama model name
   */
  resolveOllamaModelName(model: ModelInfo): string {
    const modelId = model.id.toLowerCase();

    // Check direct mappings first
    for (const [prefix, ollamaName] of Object.entries(HUGGINGFACE_TO_OLLAMA_NAMES)) {
      if (modelId.startsWith(prefix)) {
        // Extract size tag if present (e.g., "7b", "14b", "72b")
        const sizeMatch = modelId.match(/(\d+)[bB]/);
        if (sizeMatch?.[1]) {
          return `${ollamaName}:${sizeMatch[1]}b`;
        }
        return ollamaName;
      }
    }

    // Fallback: use the model ID as-is (Ollama may support it directly)
    return modelId.replace(/\//g, '/');
  }

  /**
   * Resolves the tool call method for Ollama.
   *
   * Based on evaluation findings, only Qwen2.5 models have reliable
   * tool calling support in Ollama.
   *
   * @param model - The model to check
   * @returns Tool call method or null
   */
  resolveToolCallMethod(model: ModelInfo): string | null {
    const arch = model.architecture.toLowerCase();

    // Direct match
    if (OLLAMA_TOOL_CALL_SUPPORT[arch]) {
      return OLLAMA_TOOL_CALL_SUPPORT[arch]!;
    }

    // Partial match
    for (const [archKey, method] of Object.entries(OLLAMA_TOOL_CALL_SUPPORT)) {
      if (arch.includes(archKey) || archKey.includes(arch)) {
        return method;
      }
    }

    // Check model ID
    const modelId = model.id.toLowerCase();
    if (modelId.includes('qwen')) return 'native';

    return null;
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Ensures the Ollama service is running on the remote VM.
   */
  private async ensureOllamaRunning(sshConfig: SSHConfig, modelId: string): Promise<void> {
    this.logger.info('Ensuring Ollama service is running');

    if (this.options.useDocker) {
      // Stop any existing Ollama container
      await this.execSSH(
        sshConfig,
        'docker stop ollama-server 2>/dev/null; docker rm ollama-server 2>/dev/null; true',
        this.options.startTimeoutMs,
      );

      // Start Ollama via Docker with GPU support
      const dockerCommand = [
        'docker run -d',
        '--name ollama-server',
        '--gpus all',
        `-p ${this.options.apiPort}:11434`,
        '-v ollama-data:/root/.ollama',
        this.options.dockerImage,
      ].join(' ');

      const result = await this.execSSH(
        sshConfig,
        dockerCommand,
        this.options.startTimeoutMs,
        modelId,
      );

      if (!result.success) {
        throw new OllamaServiceError(
          modelId,
          'docker start',
          new Error(`Failed to start Ollama Docker container: ${result.stderr || result.stdout}`),
        );
      }

      // Wait for Ollama to be ready
      await this.sleep(5_000);
    } else {
      // System service: check if Ollama is running, start if not
      const checkResult = await this.execSSH(
        sshConfig,
        `curl -sf http://localhost:${this.options.apiPort}/api/tags`,
        5_000,
      );

      if (!checkResult.success) {
        this.logger.info('Ollama service not responding, attempting to start');

        // Try to start Ollama
        const startResult = await this.execSSH(
          sshConfig,
          `OLLAMA_HOST=0.0.0.0:${this.options.apiPort} nohup ollama serve > /var/log/ollama.log 2>&1 &`,
          this.options.startTimeoutMs,
          modelId,
        );

        if (!startResult.success) {
          throw new OllamaServiceError(
            modelId,
            'service start',
            new Error(`Failed to start Ollama service: ${startResult.stderr || startResult.stdout}`),
          );
        }

        // Wait for Ollama to initialize
        await this.sleep(5_000);
      }
    }

    this.logger.info('Ollama service is running');
  }

  /**
   * Pulls a model from the Ollama registry.
   */
  private async pullModel(
    sshConfig: SSHConfig,
    ollamaModelName: string,
    modelId: string,
  ): Promise<void> {
    this.logger.info(`Pulling Ollama model: ${ollamaModelName}`);

    const result = await this.execSSH(
      sshConfig,
      `curl -sf -X POST http://localhost:${this.options.apiPort}/api/pull -d '{"name":"${ollamaModelName}","stream":false}'`,
      this.options.pullTimeoutMs,
      modelId,
    );

    if (!result.success) {
      throw new OllamaModelPullError(
        modelId,
        new Error(`Model pull failed: ${result.stderr || result.stdout}`),
      );
    }

    this.logger.info(`Ollama model pulled successfully: ${ollamaModelName}`);
  }

  /**
   * Loads a model into Ollama memory with specific configuration.
   */
  private async loadModel(
    sshConfig: SSHConfig,
    ollamaModelName: string,
    loadCommand: string,
    modelId: string,
  ): Promise<void> {
    this.logger.info(`Loading model into Ollama: ${ollamaModelName}`);

    const result = await this.execSSH(
      sshConfig,
      loadCommand,
      this.options.healthCheckTimeoutMs,
      modelId,
    );

    if (!result.success) {
      this.logger.warn(`Model load command returned non-success, may still be loading`, {
        stderr: result.stderr,
      });
    }
  }

  /**
   * Builds the model load command with GPU and context configuration.
   */
  buildLoadCommand(ollamaModelName: string): string {
    const options: Record<string, unknown> = {
      num_gpu: this.options.numGpuLayers,
    };

    if (this.options.numCtx !== null) {
      options.num_ctx = this.options.numCtx;
    }

    const payload = JSON.stringify({
      model: ollamaModelName,
      prompt: '',
      options,
      keep_alive: '30m',
    });

    return `curl -sf -X POST http://localhost:${this.options.apiPort}/api/generate -d '${payload}'`;
  }

  /**
   * Waits for the model to be ready by polling the Ollama API.
   */
  private async waitForModelReady(
    sshConfig: SSHConfig,
    ollamaModelName: string,
    modelId: string,
  ): Promise<HealthCheckResult> {
    const startTime = Date.now();
    let pollAttempts = 0;

    this.logger.info(`Waiting for Ollama model to be ready: ${ollamaModelName}`, {
      timeoutMs: this.options.healthCheckTimeoutMs,
    });

    while (Date.now() - startTime < this.options.healthCheckTimeoutMs) {
      pollAttempts++;

      try {
        // Check if model is loaded and responding
        const result = await this.execSSH(
          sshConfig,
          `curl -sf -X POST http://localhost:${this.options.apiPort}/api/generate -d '{"model":"${ollamaModelName}","prompt":"Hello","stream":false,"options":{"num_predict":1}}'`,
          30_000,
        );

        if (result.success && result.stdout.trim()) {
          try {
            const response = JSON.parse(result.stdout) as { done?: boolean };
            if (response.done) {
              const totalTimeMs = Date.now() - startTime;
              this.logger.info(
                `Ollama model ready: ${ollamaModelName} (${totalTimeMs}ms, ${pollAttempts} attempts)`,
              );

              return {
                healthy: true,
                totalTimeMs,
                pollAttempts,
                errorClassification: null,
                containerLogs: null,
                modelInfo: {
                  id: ollamaModelName,
                  maxModelLen: this.options.numCtx,
                  raw: { model: ollamaModelName },
                },
              };
            }
          } catch {
            // JSON parse failed, model not ready yet
          }
        }
      } catch {
        // Request failed, model not ready yet
      }

      this.logger.debug(
        `Ollama model not ready yet (${Math.round((Date.now() - startTime) / 1000)}s)`,
        { modelId, attempt: pollAttempts },
      );

      await this.sleep(this.options.healthCheckIntervalMs);
    }

    // Timeout
    const totalTimeMs = Date.now() - startTime;
    this.logger.error(`Ollama model health check timed out: ${ollamaModelName}`, {
      modelId,
      totalTimeMs,
      pollAttempts,
    });

    return {
      healthy: false,
      totalTimeMs,
      pollAttempts,
      errorClassification: {
        category: 'timeout',
        message: `Ollama model health check timed out after ${totalTimeMs}ms`,
        isFatal: false,
        recommendation: 'Check Ollama logs and ensure the model fits in available memory',
        matchedLogLines: [],
      },
      containerLogs: null,
      modelInfo: null,
    };
  }

  /**
   * Builds a human-readable deployment summary for reproducibility.
   */
  private buildDeploymentSummary(ollamaModelName: string, loadCommand: string): string {
    const lines: string[] = [
      `# Ollama Deployment Summary`,
      `ollama pull ${ollamaModelName}`,
      loadCommand,
    ];

    if (this.options.useDocker) {
      lines.unshift(`# Using Docker: ${this.options.dockerImage}`);
    }

    return lines.join('\n');
  }

  /**
   * Executes an SSH command with consistent error handling and logging.
   */
  private async execSSH(
    sshConfig: SSHConfig,
    command: string,
    timeout: number,
    _modelId?: string,
  ): Promise<CommandResult> {
    try {
      return await this.sshPool.exec(sshConfig, command, { timeout });
    } catch (error) {
      this.logger.error(`SSH command failed: ${command.slice(0, 100)}...`, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Promise-based sleep utility.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
