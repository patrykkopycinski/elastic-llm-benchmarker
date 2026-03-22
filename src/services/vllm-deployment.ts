import type { SSHConfig, VMHardwareProfile } from '../types/config.js';
import type { ModelInfo, GpuUtilization } from '../types/benchmark.js';
import type { SSHClientPool, CommandResult } from './ssh-client.js';
import { HealthCheckService } from './health-check.js';
import type { HealthCheckResult } from './health-check.js';
import {
  getVllmParamsForModel,
  UNSLOTH_CHAT_TEMPLATES_URL,
} from './vllm-model-params.js';
import { createLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Configuration options for the vLLM deployment service */
export interface VllmDeploymentOptions {
  /** Docker image to use for vLLM (default: 'vllm/vllm-openai:latest') */
  dockerImage?: string;
  /** Docker container name prefix (default: 'vllm-model') */
  containerNamePrefix?: string;
  /** Port to expose for the OpenAI-compatible API (default: 8000) */
  apiPort?: number;
  /** Timeout in milliseconds for docker pull (default: 600000 = 10 min) */
  pullTimeoutMs?: number;
  /** Timeout in milliseconds for docker run to start (default: 30000 = 30 sec) */
  runTimeoutMs?: number;
  /** Timeout in milliseconds for docker stop (default: 30000 = 30 sec) */
  stopTimeoutMs?: number;
  /** Timeout in milliseconds for health check readiness (default: 600000 = 10 min) */
  healthCheckTimeoutMs?: number;
  /** Interval in milliseconds between health check attempts (default: 10000 = 10 sec) */
  healthCheckIntervalMs?: number;
  /** Additional docker run arguments */
  additionalDockerArgs?: string[];
  /**
   * Path to chat template for tool calling (e.g. examples/tool_chat_template_llama3.1_json.jinja).
   * When set with tool-call-parser llama3_json, passed as --chat-template. Required for Llama tool calls.
   */
  chatTemplate?: string;
  /** Maximum model length override (optional, vLLM auto-detects if not set) */
  maxModelLen?: number;
  /** GPU memory utilization fraction (default: 0.90) */
  gpuMemoryUtilization?: number;
  /** HuggingFace token for accessing gated models. Passed directly to the container. */
  huggingfaceToken?: string;
  /** Whether to run Docker commands with sudo (default: false) */
  useSudo?: boolean;
  /** OTLP traces endpoint for vLLM observability (e.g. http://localhost:4317). When set, adds --otlp-traces-endpoint to the docker run command. */
  otlpTracesEndpoint?: string;
}

/** Result of a successful vLLM deployment */
export interface DeploymentResult {
  /** Docker container ID */
  containerId: string;
  /** Docker container name */
  containerName: string;
  /** The exact docker run command used (for reproducibility) */
  dockerCommand: string;
  /** The model ID deployed */
  modelId: string;
  /** The tool call parser configured */
  toolCallParser: string;
  /** Tensor parallel size used */
  tensorParallelSize: number;
  /** Maximum model length configured */
  maxModelLen: number | null;
  /** The API endpoint URL */
  apiEndpoint: string;
  /** Timestamp of deployment */
  timestamp: string;
  /** vLLM Docker image used */
  dockerImage: string;
  /** Health check result with timing and status details */
  healthCheckResult: HealthCheckResult | null;
  /** Runtime GPU utilization metrics captured after model loading */
  gpuUtilization: GpuUtilization | null;
}

/** Status of an existing vLLM container */
export interface ContainerStatus {
  /** Container ID (short) */
  containerId: string;
  /** Container name */
  containerName: string;
  /** Container state (running, exited, etc.) */
  state: string;
  /** Docker image used */
  image: string;
  /** Container uptime / status description */
  status: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DOCKER_IMAGE = 'vllm/vllm-openai:v0.15.1';
const DEFAULT_CONTAINER_NAME_PREFIX = 'vllm-model';
const DEFAULT_API_PORT = 8000;
const DEFAULT_PULL_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_RUN_TIMEOUT_MS = 30_000; // 30 seconds
const DEFAULT_STOP_TIMEOUT_MS = 60_000; // 60 seconds (large models take longer to stop)
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 1_200_000; // 20 minutes (70B+ models need extended load time)
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10_000; // 10 seconds
const DEFAULT_GPU_MEMORY_UTILIZATION = 0.9;

/** Re-export for CLI and callers that only need parser by model ID */
export { getToolCallParserForModelId } from './vllm-model-params.js';

/**
 * Builds a vLLM docker run command with tool calling enabled when supported.
 * Uses getVllmParamsForModel so chat template and extra args are set per model.
 */
export function buildDeployCommandWithToolCalling(options: {
  modelId: string;
  apiPort?: number;
  dockerImage?: string;
  tensorParallelSize?: number;
  gpuMemoryUtilization?: number;
  maxModelLen?: number;
  huggingfaceToken?: string;
  otlpTracesEndpoint?: string;
}): { command: string; toolCallParser: string | null } {
  const modelId = options.modelId;
  const apiPort = options.apiPort ?? DEFAULT_API_PORT;
  const dockerImage = options.dockerImage ?? DEFAULT_DOCKER_IMAGE;
  const tensorParallelSize = options.tensorParallelSize ?? 1;
  const gpuMemoryUtilization = options.gpuMemoryUtilization ?? DEFAULT_GPU_MEMORY_UTILIZATION;
  const maxModelLen = options.maxModelLen ?? undefined;
  const hfToken = options.huggingfaceToken ?? '${HF_TOKEN}';

  const containerName = `vllm-${modelId.replace(/[^a-zA-Z0-9.-]/g, '-').slice(0, 40)}`;
  const params = getVllmParamsForModel(modelId);

  const args: string[] = [
    'docker run -d',
    `--name ${containerName}`,
    '--gpus all',
    '--shm-size=16g',
    `-p ${apiPort}:8000`,
    `-e HF_TOKEN=${hfToken}`,
    dockerImage,
    `--model ${modelId}`,
    `--tensor-parallel-size ${tensorParallelSize}`,
    `--gpu-memory-utilization ${gpuMemoryUtilization}`,
    maxModelLen != null ? `--max-model-len ${maxModelLen}` : '--max-model-len auto',
  ].filter(Boolean);

  if (params.toolCallParser) {
    args.push(`--tool-call-parser ${params.toolCallParser}`);
    args.push('--enable-auto-tool-choice');
    if (params.chatTemplate) args.push(`--chat-template ${params.chatTemplate}`);
    for (const arg of params.extraArgs) args.push(arg);
  }

  if (options.otlpTracesEndpoint) {
    args.push(`--otlp-traces-endpoint ${options.otlpTracesEndpoint}`);
  }

  return { command: args.join(' \\\n  '), toolCallParser: params.toolCallParser };
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Base error class for vLLM deployment operations */
export class VllmDeploymentError extends Error {
  constructor(
    message: string,
    public readonly modelId: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'VllmDeploymentError';
  }
}

/** Error thrown when Docker container operations fail */
export class ContainerError extends VllmDeploymentError {
  constructor(
    modelId: string,
    public readonly operation: 'stop' | 'pull' | 'run' | 'inspect',
    public readonly containerName: string,
    cause?: Error,
  ) {
    super(
      `Docker ${operation} failed for container '${containerName}' (model: ${modelId}): ${cause?.message ?? 'unknown error'}`,
      modelId,
      cause,
    );
    this.name = 'ContainerError';
  }
}

/** Error thrown when the vLLM health check fails or times out */
export class HealthCheckError extends VllmDeploymentError {
  constructor(
    modelId: string,
    public readonly timeoutMs: number,
    public readonly lastError?: string,
  ) {
    super(
      `vLLM health check timed out after ${timeoutMs}ms for model ${modelId}${lastError ? `: ${lastError}` : ''}`,
      modelId,
    );
    this.name = 'HealthCheckError';
  }
}

// ─── vLLM Deployment Service ──────────────────────────────────────────────────

/**
 * Service for deploying LLM models via vLLM on remote VMs using Docker.
 *
 * Handles the complete Docker container lifecycle:
 * 1. Stop any existing vLLM containers
 * 2. Pull the latest vLLM OpenAI-compatible image
 * 3. Configure and launch a new container with appropriate settings
 * 4. Wait for health check readiness
 * 5. Store the exact deployment command for reproducibility
 *
 * Configuration is determined automatically based on:
 * - **tensor-parallel-size**: Matches the GPU count from the hardware profile
 * - **tool-call-parser**: Selected based on model architecture (hermes/mistral/llama3_json)
 * - **enable-auto-tool-choice**: Enabled when a tool call parser is available
 * - **max-model-len**: Optional override; vLLM auto-detects from model config by default
 *
 * @example
 * ```typescript
 * const sshPool = new SSHClientPool();
 * const deployer = new VllmDeploymentService(sshPool, 'info');
 *
 * const result = await deployer.deploy(sshConfig, model, hardwareProfile);
 * console.log(`Deployed at: ${result.apiEndpoint}`);
 * console.log(`Reproducible command: ${result.dockerCommand}`);
 *
 * await deployer.stop(sshConfig, result.containerName);
 * ```
 */
export class VllmDeploymentService {
  private readonly logger;
  private readonly healthCheckService: HealthCheckService;
  private readonly options: Required<
    Omit<VllmDeploymentOptions, 'additionalDockerArgs' | 'maxModelLen' | 'huggingfaceToken' | 'chatTemplate' | 'otlpTracesEndpoint'>
  > & {
    additionalDockerArgs: string[];
    maxModelLen: number | null;
    huggingfaceToken: string | null;
    chatTemplate?: string;
    useSudo: boolean;
    otlpTracesEndpoint: string | null;
  };

  /**
   * Creates a new VllmDeploymentService instance.
   *
   * @param sshPool - SSH client pool for remote command execution
   * @param logLevel - Winston log level (default: 'info')
   * @param options - Deployment configuration options
   */
  constructor(
    private readonly sshPool: SSHClientPool,
    logLevel: string = 'info',
    options: VllmDeploymentOptions = {},
  ) {
    this.logger = createLogger(logLevel);
    this.options = {
      dockerImage: options.dockerImage ?? DEFAULT_DOCKER_IMAGE,
      containerNamePrefix: options.containerNamePrefix ?? DEFAULT_CONTAINER_NAME_PREFIX,
      apiPort: options.apiPort ?? DEFAULT_API_PORT,
      pullTimeoutMs: options.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS,
      runTimeoutMs: options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      healthCheckTimeoutMs: options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
      healthCheckIntervalMs: options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS,
      additionalDockerArgs: options.additionalDockerArgs ?? [],
      chatTemplate: options.chatTemplate,
      maxModelLen: options.maxModelLen ?? null,
      gpuMemoryUtilization: options.gpuMemoryUtilization ?? DEFAULT_GPU_MEMORY_UTILIZATION,
      huggingfaceToken: options.huggingfaceToken ?? null,
      useSudo: options.useSudo ?? false,
      otlpTracesEndpoint: options.otlpTracesEndpoint ?? null,
    };

    // Initialize the health check service with matching configuration
    this.healthCheckService = new HealthCheckService(sshPool, logLevel, {
      timeoutMs: this.options.healthCheckTimeoutMs,
      intervalMs: this.options.healthCheckIntervalMs,
      apiPort: this.options.apiPort,
      useSudo: this.options.useSudo,
    });

    this.logger.info('VllmDeploymentService initialized', {
      dockerImage: this.options.dockerImage,
      apiPort: this.options.apiPort,
      gpuMemoryUtilization: this.options.gpuMemoryUtilization,
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns the underlying HealthCheckService instance for direct health
   * check operations outside of the deployment flow.
   */
  getHealthCheckService(): HealthCheckService {
    return this.healthCheckService;
  }

  /**
   * Deploys a model via vLLM on a remote VM.
   *
   * Performs the full deployment lifecycle:
   * 1. Stops any existing vLLM containers on the target VM
   * 2. Pulls the vLLM Docker image
   * 3. Launches a new container with model-specific configuration
   * 4. Waits for the vLLM server to pass health checks
   *
   * @param sshConfig - SSH connection configuration for the target VM
   * @param model - The model to deploy
   * @param hardwareProfile - Hardware profile of the target VM
   * @returns Deployment result with container details and the reproducible command
   * @throws {ContainerError} If any Docker operation fails
   * @throws {HealthCheckError} If the health check times out
   */
  async deploy(
    sshConfig: SSHConfig,
    model: ModelInfo,
    hardwareProfile: VMHardwareProfile,
  ): Promise<DeploymentResult> {
    const containerName = this.generateContainerName(model.id);
    const tensorParallelSize = hardwareProfile.gpuCount;

    // Resolve model-specific vLLM params (chat template, tool parser, extra args) before deploy
    const vllmParams = getVllmParamsForModel(model.id, model.architecture);
    this.logger.info(`vLLM params for evaluation: ${model.id}`, {
      family: vllmParams.family,
      toolCallParser: vllmParams.toolCallParser,
      chatTemplate: vllmParams.chatTemplate ?? '(none)',
      extraArgs: vllmParams.extraArgs.length > 0 ? vllmParams.extraArgs : undefined,
    });
    if (vllmParams.unslothTemplateKey) {
      this.logger.info(`Unsloth recommends chat template: ${vllmParams.unslothTemplateKey}`, {
        see: UNSLOTH_CHAT_TEMPLATES_URL,
      });
    }
    this.logger.info(`Starting deployment of model: ${model.id}`, {
      containerName,
      toolCallParser: vllmParams.toolCallParser,
      tensorParallelSize,
      gpuType: hardwareProfile.gpuType,
      gpuCount: hardwareProfile.gpuCount,
    });
    if (vllmParams.toolCallParser) {
      this.logger.info(`Tool calling enabled for ${model.id}`, {
        toolCallParser: vllmParams.toolCallParser,
        chatTemplate: vllmParams.chatTemplate ?? '(use default)',
        flags: ['--tool-call-parser', '--enable-auto-tool-choice'].concat(
          vllmParams.chatTemplate ? ['--chat-template'] : [],
        ),
      });
    }

    // Step 1: Stop existing vLLM containers
    await this.stopExistingContainers(sshConfig, model.id);

    // Step 2: Pull the Docker image
    await this.pullImage(sshConfig, model.id);

    // Step 3: Build and execute the docker run command (uses vllmParams)
    const dockerCommand = this.buildDockerRunCommand(model, containerName, tensorParallelSize);

    this.logger.info(`Launching vLLM container: ${containerName}`, {
      command: dockerCommand,
    });

    const runResult = await this.execSSH(
      sshConfig,
      dockerCommand,
      this.options.runTimeoutMs,
      model.id,
    );

    if (!runResult.success) {
      throw new ContainerError(
        model.id,
        'run',
        containerName,
        new Error(`docker run failed: ${runResult.stderr || runResult.stdout}`),
      );
    }

    const containerId = runResult.stdout.trim();

    this.logger.info(`Container started: ${containerId}`, {
      containerName,
      modelId: model.id,
    });

    // Step 4: Wait for health check using the HealthCheckService
    const healthCheckResult = await this.healthCheckService.waitForHealthy(
      sshConfig,
      containerName,
      model.id,
    );

    // Step 5: Determine max-model-len from health check result or running container
    let maxModelLen: number | null = healthCheckResult.modelInfo?.maxModelLen ?? null;
    if (maxModelLen === null) {
      maxModelLen = await this.detectMaxModelLen(sshConfig, containerName, model.id);
    }

    // Step 6: Capture GPU utilization metrics
    const gpuUtilization = await this.healthCheckService.queryGpuUtilization(sshConfig);
    if (gpuUtilization) {
      this.logger.info(`GPU utilization after deployment: ${gpuUtilization.vramUtilizationPct}%`, {
        totalVramUsedGb: gpuUtilization.totalVramUsedGb,
        totalVramTotalGb: gpuUtilization.totalVramTotalGb,
        perGpuUsedGb: gpuUtilization.vramUsedGb,
      });
    }

    const apiEndpoint = `http://${sshConfig.host}:${this.options.apiPort}`;

    const result: DeploymentResult = {
      containerId,
      containerName,
      dockerCommand,
      modelId: model.id,
      toolCallParser: vllmParams.toolCallParser ?? '',
      tensorParallelSize,
      maxModelLen,
      apiEndpoint,
      timestamp: new Date().toISOString(),
      dockerImage: this.options.dockerImage,
      healthCheckResult,
      gpuUtilization,
    };

    this.logger.info(`Deployment successful: ${model.id}`, {
      containerId,
      apiEndpoint,
      toolCallParser: vllmParams.toolCallParser,
      tensorParallelSize,
      healthCheckTimeMs: healthCheckResult.totalTimeMs,
    });

    return result;
  }

  /**
   * Stops a specific vLLM container by name.
   *
   * @param sshConfig - SSH connection configuration
   * @param containerName - Name of the container to stop
   * @returns True if the container was stopped, false if it wasn't running
   */
  async stop(sshConfig: SSHConfig, containerName: string): Promise<boolean> {
    this.logger.info(`Stopping container: ${containerName}`);

    const result = await this.execSSH(
      sshConfig,
      `docker stop ${containerName} && docker rm ${containerName}`,
      this.options.stopTimeoutMs,
    );

    if (result.success) {
      this.logger.info(`Container stopped and removed: ${containerName}`);
      return true;
    }

    // Container might not exist or already stopped
    if (result.stderr.includes('No such container') || result.stderr.includes('not found')) {
      this.logger.debug(`Container not found (already stopped?): ${containerName}`);
      return false;
    }

    this.logger.warn(`Failed to stop container: ${containerName}`, {
      stderr: result.stderr,
    });
    return false;
  }

  /**
   * Lists all running vLLM containers on the target VM.
   *
   * @param sshConfig - SSH connection configuration
   * @returns Array of container status objects
   */
  async listContainers(sshConfig: SSHConfig): Promise<ContainerStatus[]> {
    const result = await this.execSSH(
      sshConfig,
      'docker ps -a --filter "ancestor=vllm/vllm-openai" --format "{{.ID}}|{{.Names}}|{{.State}}|{{.Image}}|{{.Status}}"',
      this.options.stopTimeoutMs,
    );

    if (!result.success || !result.stdout.trim()) {
      return [];
    }

    return result.stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const parts = line.split('|');
        return {
          containerId: parts[0] ?? '',
          containerName: parts[1] ?? '',
          state: parts[2] ?? '',
          image: parts[3] ?? '',
          status: parts[4] ?? '',
        };
      });
  }

  /**
   * Gets the logs from a vLLM container.
   *
   * @param sshConfig - SSH connection configuration
   * @param containerName - Name of the container
   * @param tailLines - Number of tail lines to retrieve (default: 100)
   * @returns Container log output
   */
  async getContainerLogs(
    sshConfig: SSHConfig,
    containerName: string,
    tailLines: number = 100,
  ): Promise<string> {
    const result = await this.execSSH(
      sshConfig,
      `docker logs --tail ${tailLines} ${containerName} 2>&1`,
      this.options.stopTimeoutMs,
    );

    return result.stdout;
  }

  /**
   * Resolves the appropriate vLLM tool call parser for a model.
   * Delegates to the central model-params resolver (chat template and extra args
   * are applied in buildDockerRunCommand).
   */
  resolveToolCallParser(model: ModelInfo): string | null {
    return getVllmParamsForModel(model.id, model.architecture).toolCallParser;
  }

  /**
   * Builds the full docker run command for vLLM deployment.
   * Resolves model-specific params (parser, chat template, extra args) and
   * applies config overrides (chatTemplate, additionalDockerArgs).
   *
   * @param model - The model to deploy
   * @param containerName - Container name
   * @param tensorParallelSize - Number of GPUs for tensor parallelism
   * @returns The complete docker run command string
   */
  buildDockerRunCommand(
    model: ModelInfo,
    containerName: string,
    tensorParallelSize: number,
  ): string {
    const params = getVllmParamsForModel(model.id, model.architecture);
    const args: string[] = [
      'docker run -d',
      `--name ${containerName}`,
      '--gpus all',
      '--shm-size=16g',
      `-p ${this.options.apiPort}:8000`,
      `-e HF_TOKEN=${this.options.huggingfaceToken ?? '${HF_TOKEN}'}`,
      this.options.dockerImage,
      `--model ${model.id}`,
      `--tensor-parallel-size ${tensorParallelSize}`,
      `--gpu-memory-utilization ${this.options.gpuMemoryUtilization}`,
      `--max-model-len ${this.options.maxModelLen ?? 'auto'}`,
    ];

    if (params.toolCallParser) {
      args.push(`--tool-call-parser ${params.toolCallParser}`);
      args.push('--enable-auto-tool-choice');
      const chatTemplate = this.options.chatTemplate ?? params.chatTemplate;
      if (chatTemplate) args.push(`--chat-template ${chatTemplate}`);
      for (const arg of params.extraArgs) args.push(arg);
    }

    if (this.options.otlpTracesEndpoint) {
      args.push(`--otlp-traces-endpoint ${this.options.otlpTracesEndpoint}`);
    }

    for (const arg of this.options.additionalDockerArgs) {
      args.push(arg);
    }

    return args.join(' \\\n  ');
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Stops all existing vLLM containers on the remote VM.
   * This ensures a clean slate before deploying a new model.
   */
  private async stopExistingContainers(sshConfig: SSHConfig, modelId: string): Promise<void> {
    this.logger.info('Stopping existing vLLM containers');

    const containers = await this.listContainers(sshConfig);

    if (containers.length === 0) {
      this.logger.debug('No existing vLLM containers found');
      return;
    }

    this.logger.info(`Found ${containers.length} existing vLLM container(s) to stop`, {
      containers: containers.map((c) => c.containerName),
    });

    for (const container of containers) {
      try {
        // Use docker rm -f which sends SIGKILL immediately — avoids the slow
        // graceful shutdown that causes timeouts with large models loading.
        await this.execSSH(
          sshConfig,
          `docker rm -f ${container.containerName}`,
          this.options.stopTimeoutMs,
          modelId,
        );
        this.logger.info(`Removed container: ${container.containerName}`);
      } catch (error) {
        this.logger.warn(
          `Failed to remove container ${container.containerName}`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    }

    this.logger.info('All existing vLLM containers stopped');
  }

  /**
   * Pulls the vLLM Docker image on the remote VM.
   */
  private async pullImage(sshConfig: SSHConfig, modelId: string): Promise<void> {
    this.logger.info(`Pulling Docker image: ${this.options.dockerImage}`);

    const result = await this.execSSH(
      sshConfig,
      `docker pull ${this.options.dockerImage}`,
      this.options.pullTimeoutMs,
      modelId,
    );

    if (!result.success) {
      throw new ContainerError(
        modelId,
        'pull',
        this.options.dockerImage,
        new Error(`docker pull failed: ${result.stderr || result.stdout}`),
      );
    }

    this.logger.info(`Docker image pulled successfully: ${this.options.dockerImage}`, {
      durationMs: result.durationMs,
    });
  }

  /**
   * Attempts to detect the effective max-model-len from the running vLLM container
   * by querying the /v1/models endpoint.
   */
  private async detectMaxModelLen(
    sshConfig: SSHConfig,
    containerName: string,
    modelId: string,
  ): Promise<number | null> {
    if (this.options.maxModelLen !== null) {
      return this.options.maxModelLen;
    }

    try {
      const result = await this.execSSH(
        sshConfig,
        `curl -sf http://localhost:${this.options.apiPort}/v1/models`,
        10_000,
      );

      if (result.success && result.stdout.trim()) {
        const response = JSON.parse(result.stdout) as {
          data?: Array<{ max_model_len?: number }>;
        };
        const modelData = response.data?.[0];
        if (modelData?.max_model_len) {
          this.logger.info(`Detected max-model-len: ${modelData.max_model_len}`, {
            containerName,
            modelId,
          });
          return modelData.max_model_len;
        }
      }
    } catch (error) {
      this.logger.debug('Could not detect max-model-len from /v1/models endpoint', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return null;
  }

  /**
   * Generates a sanitized container name from the model ID.
   * Docker container names only support [a-zA-Z0-9][a-zA-Z0-9_.-]
   */
  private generateContainerName(modelId: string): string {
    const sanitized = modelId
      .toLowerCase()
      .replace(/\//g, '-')
      .replace(/[^a-z0-9_.-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    return `${this.options.containerNamePrefix}-${sanitized}`;
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
      return await this.sshPool.exec(sshConfig, command, {
        timeout,
        sudo: this.options.useSudo,
      });
    } catch (error) {
      this.logger.error(`SSH command failed: ${command.slice(0, 100)}...`, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

}
