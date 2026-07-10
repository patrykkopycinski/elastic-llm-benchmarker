import type { SSHConfig, VMHardwareProfile, HealthCheckTimeoutTier } from '../types/config.js';
import { resolveHealthCheckTimeoutMsFromTiers } from '../types/config.js';
import type { ModelInfo, GpuUtilization } from '../types/benchmark.js';
import type { SSHClientPool, CommandResult } from './ssh-client.js';
import { HealthCheckService } from './health-check.js';
import type { HealthCheckResult } from './health-check.js';
import {
  getVllmParamsForModel,
  UNSLOTH_CHAT_TEMPLATES_URL,
} from './vllm-model-params.js';
import { getBytesPerParamForQuantizations } from './model-candidate-filter.js';
import { createLogger } from '../utils/logger.js';

/** Redact secret-bearing `-e KEY=value` flags before logging shell commands. */
export function redactShellCommand(command: string): string {
  return command.replace(/(-e\s+(?:HF_TOKEN|HUGGINGFACE_TOKEN|AWS_SECRET_ACCESS_KEY)=)(\S+)/gi, '$1[REDACTED]');
}

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
  /**
   * Docker volume (or host path) mounted at /root/.cache/huggingface so downloaded model
   * weights persist across deploys and are shared between models, instead of landing in each
   * container's copy-on-write layer (the root cause of the GPU VM filling to 100%). Default:
   * `vllm-hf-cache` (a docker-managed named volume). Set to '' to disable the mount.
   */
  hfCacheVolume?: string;
  /**
   * Minimum free disk (GB) required on the docker filesystem before a deploy.
   * When free space is below this, a pre-deploy GC prunes dead docker resources,
   * clears the host HuggingFace prefetch cache, then LRU-evicts the oldest cached
   * model weight sets from the shared `vllm-hf-cache` volume (never the model
   * being deployed) until the threshold clears.
   * Default 80 (headroom for a ~70B download). Set to 0 to disable the check.
   */
  minFreeDiskGb?: number;
  /**
   * Fixed headroom (GB) added on top of the incoming model's estimated weight
   * size when computing the disk-space reservation for a deploy — covers the
   * container's writable layer, tokenizer/config files, and vLLM's on-disk
   * compilation/CUDA-graph cache. Default 20.
   */
  modelLoadHeadroomGb?: number;
  /**
   * Model-size-aware health check timeout tiers (see `resolveHealthCheckTimeoutSeconds`
   * in `types/config.ts`). When set, overrides the flat `healthCheckTimeoutMs` for models
   * with a known parameter count — a 235B model gets a longer window than a 7B model.
   */
  healthCheckTimeoutSecondsTiers?: HealthCheckTimeoutTier[];
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

const DEFAULT_DOCKER_IMAGE = 'vllm/vllm-openai:latest';
const DEFAULT_CONTAINER_NAME_PREFIX = 'vllm-model';

/** Docker-safe container name for a HuggingFace model id (matches deploy naming). */
export function modelIdToContainerName(
  modelId: string,
  prefix: string = DEFAULT_CONTAINER_NAME_PREFIX,
): string {
  const sanitized = modelId
    .toLowerCase()
    .replace(/\//g, '-')
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `${prefix}-${sanitized}`;
}
const DEFAULT_API_PORT = 8000;
const DEFAULT_PULL_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_RUN_TIMEOUT_MS = 30_000; // 30 seconds
const DEFAULT_STOP_TIMEOUT_MS = 60_000; // 60 seconds (large models take longer to stop)
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 1_800_000; // 30 minutes. Ceiling for the poll-until-ready wait; large models (35B+) downloading weights on first run need extended load time. Fast models return on first healthy poll and fatal errors (OOM/arch) abort early, so a high ceiling is zero-cost for them.
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10_000; // 10 seconds
const DEFAULT_GPU_MEMORY_UTILIZATION = 0.95;

/** Re-export for CLI and callers that only need parser by model ID */
export { getToolCallParserForModelId } from './vllm-model-params.js';

/**
 * Builds a vLLM docker run command with tool calling enabled when supported.
 * Uses getVllmParamsForModel so chat template and extra args are set per model.
 */
export function buildDeployCommandWithToolCalling(options: {
  modelId: string;
  /**
   * Model architecture (e.g. "llama", "LlamaForCausalLM"). Threaded into the param
   * resolver so Llama-derived fine-tunes whose id lacks "llama" (e.g. Foundation-Sec)
   * still get the tool-call flags. Matches the arch-aware `deploy()` path.
   */
  architecture?: string | null;
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
  const tensorParallelSize = options.tensorParallelSize ?? 2;
  const gpuMemoryUtilization = options.gpuMemoryUtilization ?? DEFAULT_GPU_MEMORY_UTILIZATION;
  const maxModelLen = options.maxModelLen ?? undefined;
  const hfToken = options.huggingfaceToken ?? '${HF_TOKEN}';

  const containerName = `vllm-${modelId.replace(/[^a-zA-Z0-9.-]/g, '-').slice(0, 40)}`;
  const params = getVllmParamsForModel(modelId, options.architecture);

  const args: string[] = [
    'docker run -d',
    `--name ${containerName}`,
    // Customer-facing deploy command: keep auto-restart so a crashed vLLM recovers unattended.
    '--restart unless-stopped',
    '--gpus all',
    '--shm-size=16g',
    // Share/persist model weights across deploys instead of bloating the container layer.
    '-v vllm-hf-cache:/root/.cache/huggingface',
    `-p ${apiPort}:8000`,
    `-e HF_TOKEN=${hfToken}`,
    dockerImage,
    `--model ${modelId}`,
    `--tensor-parallel-size ${tensorParallelSize}`,
    `--gpu-memory-utilization ${gpuMemoryUtilization}`,
    maxModelLen !== null && maxModelLen !== undefined
      ? `--max-model-len ${maxModelLen}`
      : '--max-model-len auto',
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
    Omit<
      VllmDeploymentOptions,
      | 'additionalDockerArgs'
      | 'maxModelLen'
      | 'huggingfaceToken'
      | 'chatTemplate'
      | 'otlpTracesEndpoint'
      | 'healthCheckTimeoutSecondsTiers'
    >
  > & {
    additionalDockerArgs: string[];
    maxModelLen: number | null;
    huggingfaceToken: string | null;
    chatTemplate?: string;
    useSudo: boolean;
    otlpTracesEndpoint: string | null;
    minFreeDiskGb: number;
    modelLoadHeadroomGb: number;
    healthCheckTimeoutSecondsTiers: HealthCheckTimeoutTier[];
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
      hfCacheVolume: options.hfCacheVolume ?? 'vllm-hf-cache',
      minFreeDiskGb: options.minFreeDiskGb ?? 80,
      modelLoadHeadroomGb: options.modelLoadHeadroomGb ?? 20,
      healthCheckTimeoutSecondsTiers: options.healthCheckTimeoutSecondsTiers ?? [],
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
    deploymentOverrides?: VllmDeploymentOptions,
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

    // Step 0: Reclaim disk if the VM doesn't have room for THIS model's weights
    // (not just some flat floor), so the weight download + container layer never
    // hit "no space left on device" mid-deploy. Best-effort: never blocks the
    // deploy — if the disk is genuinely full the docker run fails and the
    // scheduler's classifier retries it after this GC has run once.
    const estimatedModelGb = this.estimateModelDiskGb(model);
    await this.ensureDiskSpace(sshConfig, model.id, estimatedModelGb);

    // Step 1: Stop existing vLLM containers
    await this.stopExistingContainers(sshConfig, model.id);

    // Step 2: Pull the Docker image
    await this.pullImage(sshConfig, model.id);

    // Step 2.5: Force-remove any container squatting on our exact name. The
    // ancestor-filtered sweep in stopExistingContainers() misses containers whose
    // image digest drifted from the current `vllm/vllm-openai:latest` — a stale
    // container from a prior run of the SAME model survives the sweep and then
    // collides on `docker run --name` ("name is already in use"). Removing by exact
    // name is filter- and state-independent, so the run below can never conflict.
    // A missing container makes `docker rm -f` exit non-zero; that is expected and
    // ignored (nothing to remove is success for our purposes).
    await this.execSSH(
      sshConfig,
      `docker rm -f ${containerName}`,
      this.options.stopTimeoutMs,
      model.id,
    );

    // Step 3: Build and execute the docker run command (uses vllmParams)
    const dockerCommand = this.buildDockerRunCommand(
      model,
      containerName,
      tensorParallelSize,
      deploymentOverrides,
    );

    this.logger.info(`Launching vLLM container: ${containerName}`, {
      command: redactShellCommand(dockerCommand),
    });

    let runResult = await this.execSSH(
      sshConfig,
      dockerCommand,
      this.options.runTimeoutMs,
      model.id,
    );

    // Self-heal on a name conflict. The Step 2.5 `docker rm -f` above can leave the
    // name squatted when the stale container is in a Dead / removal-in-progress state
    // or when a prior externally-killed container exited without being removed — the
    // rm returns non-zero, we ignore it, and `docker run --name` then reports
    // "Conflict. The container name ... is already in use". A force-remove by exact
    // name + single retry clears that deterministically instead of failing Stage 1.
    if (!runResult.success && /already in use|Conflict\b/i.test(runResult.stderr || runResult.stdout)) {
      this.logger.warn(
        `Container name '${containerName}' still in use — force-removing and retrying run once`,
        { stderr: (runResult.stderr || runResult.stdout).slice(0, 200) },
      );
      await this.execSSH(sshConfig, `docker rm -f ${containerName}`, this.options.stopTimeoutMs, model.id);
      runResult = await this.execSSH(sshConfig, dockerCommand, this.options.runTimeoutMs, model.id);
    }

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

    // Step 4: Wait for health check using the HealthCheckService. Larger models
    // take proportionally longer to load weights + build CUDA graphs, so the
    // timeout is resolved per-model from healthCheckTimeoutSecondsTiers rather
    // than using one flat timeout for a 7B and a 235B model alike.
    const healthCheckTimeoutMs = resolveHealthCheckTimeoutMsFromTiers(
      this.options.healthCheckTimeoutSecondsTiers,
      this.options.healthCheckTimeoutMs,
      model.parameterCount !== null ? model.parameterCount / 1e9 : null,
    );
    let healthCheckResult: HealthCheckResult;
    try {
      healthCheckResult = await this.healthCheckService.waitForHealthy(
        sshConfig,
        containerName,
        model.id,
        healthCheckTimeoutMs,
      );
    } catch (healthCheckErr) {
      // A failed health check (timeout, OOM, CUDA error, etc.) leaves a container
      // running/dead on the VM holding GPU memory and disk. Stage1Worker's
      // `deployment` local is still null at this point (the deploy() call never
      // returned), so its finally-block "scheduler owns teardown" log never
      // fires and nothing else stops this container — clean it up here, at the
      // one place that actually knows the container name, instead of leaking it
      // until an unrelated later deploy's stopExistingContainers() sweep finds it.
      this.logger.warn(
        `Deploy failed post-launch — removing container '${containerName}' to avoid an orphan`,
        {
          modelId: model.id,
          error: healthCheckErr instanceof Error ? healthCheckErr.message : String(healthCheckErr),
        },
      );
      await this.execSSH(
        sshConfig,
        `docker rm -f ${containerName}`,
        this.options.stopTimeoutMs,
        model.id,
      ).catch((rmErr) => {
        this.logger.error(`Failed to remove orphaned container '${containerName}'`, {
          modelId: model.id,
          error: rmErr instanceof Error ? rmErr.message : String(rmErr),
        });
      });
      throw healthCheckErr;
    }

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

    // Step 7: Resolve actual vLLM version from the running container
    const resolvedImage = await this.resolveVllmVersion(sshConfig, containerName);

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
      dockerImage: resolvedImage,
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

    // If the combined command failed (e.g. 'docker rm' lacks sudo because
    // sudo only wraps the first half of the && chain), try rm separately.
    if (!result.success && !result.stderr.includes('No such container')) {
      await this.execSSH(sshConfig, `docker rm -f ${containerName}`, this.options.stopTimeoutMs);
    }

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
    overrides?: VllmDeploymentOptions,
  ): string {
    const opts = { ...this.options, ...overrides };
    const params = getVllmParamsForModel(model.id, model.architecture);
    // When OTLP tracing is enabled, use host networking so a containerized vLLM
    // can push traces to a loopback reverse-SSH tunnel (the local EDOT collector)
    // without requiring GatewayPorts on the VM's sshd. /metrics still binds on
    // host:apiPort, so Prometheus scraping is unaffected.
    const useHostNetwork = Boolean(opts.otlpTracesEndpoint);
    // NOTE: no `--restart unless-stopped` here (unlike the customer-facing command). During
    // Stage 1 the benchmark runs as a `docker exec` against this container; if vLLM crashes
    // under load an auto-restart would respawn it mid-benchmark and kill the exec'd process
    // (observed as exit code 137). The Stage-2 keep-alive requirement is met separately by
    // CiEvalInfrastructureGuard.ensureRestartPolicy(), which applies `docker update --restart
    // unless-stopped` (and `docker start`s on exit) only for the CI-eval polling window.
    const args: string[] = [
      'docker run -d',
      `--name ${containerName}`,
      '--gpus all',
      '--shm-size=16g',
    ];
    // Persist/share HF weights across deploys so they don't accumulate in each container's
    // writable layer (the root cause of the GPU VM disk filling to 100%). Configurable/disable-able.
    const hfCacheVolume = opts.hfCacheVolume ?? 'vllm-hf-cache';
    if (hfCacheVolume) {
      args.push(`-v ${hfCacheVolume}:/root/.cache/huggingface`);
    }
    args.push(useHostNetwork ? '--network host' : `-p ${opts.apiPort}:8000`);
    args.push(`-e HF_TOKEN=${opts.huggingfaceToken ?? '${HF_TOKEN}'}`);
    if (opts.maxModelLen !== null && opts.maxModelLen > 32_768) {
      args.push('-e VLLM_ALLOW_LONG_MAX_MODEL_LEN=1');
    }
    args.push(
      opts.dockerImage,
      `--model ${model.id}`,
      `--tensor-parallel-size ${tensorParallelSize}`,
      `--gpu-memory-utilization ${opts.gpuMemoryUtilization}`,
      `--max-model-len ${opts.maxModelLen ?? 'auto'}`,
    );
    // In host-network mode vLLM ignores Docker port mapping, so bind it to the
    // expected apiPort explicitly (default 8000 matches, but be exact).
    if (useHostNetwork) {
      args.push(`--port ${opts.apiPort}`);
    }

    if (params.toolCallParser) {
      args.push(`--tool-call-parser ${params.toolCallParser}`);
      args.push('--enable-auto-tool-choice');
      const chatTemplate = opts.chatTemplate ?? params.chatTemplate;
      if (chatTemplate) args.push(`--chat-template ${chatTemplate}`);
      for (const arg of params.extraArgs) args.push(arg);
    }

    if (opts.otlpTracesEndpoint) {
      args.push(`--otlp-traces-endpoint ${opts.otlpTracesEndpoint}`);
    }

    for (const arg of opts.additionalDockerArgs) {
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
    const image = this.options.dockerImage;

    // Digest-based skip: avoid re-pulling if local image matches remote.
    try {
      const localDigestResult = await this.execSSH(
        sshConfig,
        `docker inspect --format='{{index .RepoDigests 0}}' ${image} 2>/dev/null || echo 'NOT_FOUND'`,
        30_000,
        modelId,
      );
      const localDigest = localDigestResult.success
        ? localDigestResult.stdout.trim()
        : '';

      const remoteDigestResult = await this.execSSH(
        sshConfig,
        `docker manifest inspect ${image} 2>/dev/null | grep -m1 '"digest"' | cut -d'"' -f4 || echo 'UNKNOWN'`,
        30_000,
        modelId,
      );
      const remoteDigest = remoteDigestResult.success
        ? remoteDigestResult.stdout.trim()
        : '';

      if (
        localDigest.length > 10 &&
        remoteDigest.length > 10 &&
        localDigest.includes(remoteDigest)
      ) {
        this.logger.info(`Docker image up-to-date, skipping pull`, {
          image,
          digest: remoteDigest,
        });
        return;
      }
    } catch {
      // Digest check is best-effort; fall through to pull.
    }

    this.logger.info(`Pulling Docker image: ${image}`);
    const result = await this.execSSH(
      sshConfig,
      `docker pull ${image}`,
      this.options.pullTimeoutMs,
      modelId,
    );

    if (!result.success) {
      throw new ContainerError(
        modelId,
        'pull',
        image,
        new Error(`docker pull failed: ${result.stderr || result.stdout}`),
      );
    }

    this.logger.info(`Docker image pulled successfully: ${image}`, {
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
   * Resolves the actual vLLM version from a running container.
   * When using the :latest tag, this queries `pip show vllm` inside the container
   * to get the real installed version. Falls back to the configured image tag.
   */
  private async resolveVllmVersion(
    sshConfig: SSHConfig,
    containerName: string,
  ): Promise<string> {
    try {
      const result = await this.execSSH(
        sshConfig,
        `docker exec ${containerName} pip show vllm 2>/dev/null | grep -i '^Version:' | awk '{print $2}'`,
        15_000,
      );
      const version = result.stdout.trim();
      if (version && /^\d+\.\d+/.test(version)) {
        const resolved = `vllm/vllm-openai:v${version}`;
        this.logger.info(`Resolved vLLM version: ${resolved} (from container ${containerName})`);
        return resolved;
      }
    } catch (error) {
      this.logger.debug('Could not resolve vLLM version from container', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.options.dockerImage;
  }

  /**
   * Generates a sanitized container name from the model ID.
   * Docker container names only support [a-zA-Z0-9][a-zA-Z0-9_.-]
   */
  private generateContainerName(modelId: string): string {
    return modelIdToContainerName(modelId, this.options.containerNamePrefix);
  }

  /**
   * Estimates on-disk footprint (GB) for a model's weights, plus a fixed
   * headroom for the container writable layer / vLLM compile cache. Reuses
   * the same bytes-per-parameter precision table as candidate filtering
   * (`getBytesPerParamForQuantizations`) so a quantized model reserves its
   * real (smaller) footprint rather than a worst-case BF16 estimate. Returns
   * null when `parameterCount` is unknown — callers fall back to the static
   * `minFreeDiskGb` floor in that case rather than guessing.
   */
  private estimateModelDiskGb(model: ModelInfo): number | null {
    if (!model.parameterCount || model.parameterCount <= 0) return null;
    const bytesPerParam = getBytesPerParamForQuantizations(model.quantizations);
    const weightsGb = (model.parameterCount * bytesPerParam) / 1024 ** 3;
    return Math.ceil(weightsGb + this.options.modelLoadHeadroomGb);
  }

  /**
   * Read free disk (GB) on the docker filesystem. Returns null if it can't be
   * parsed (df/docker unavailable) so callers fail open rather than GC blindly.
   */
  private async readFreeDiskGb(sshConfig: SSHConfig): Promise<number | null> {
    try {
      const result = await this.execSSH(
        sshConfig,
        `df -PBG "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)" | awk 'NR==2 {gsub(/[^0-9]/,"",$4); print $4}'`,
        20_000,
      );
      const gb = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(gb) ? gb : null;
    } catch {
      return null;
    }
  }

  /**
   * Pre-deploy disk hygiene. When free space is below `minFreeDiskGb`, reclaim
   * space in escalating, SAFE steps and re-check after each:
   *   1. `docker system prune -f` — dead containers, dangling images, build
   *      cache, unused networks. Never touches named volumes or in-use images.
   *   2. Clear the HOST HuggingFace prefetch cache (`~/.cache/huggingface/hub`,
   *      and `/root/...` when running docker with sudo). This is the download
   *      cache used by `prefetchWeights` on the host; the container serves
   *      weights from the `vllm-hf-cache` docker volume, so clearing the host
   *      cache never breaks a running model.
   *   3. LRU-evict the OLDEST cached models from the `vllm-hf-cache` docker
   *      volume (skipping the model about to be deployed), one at a time, until
   *      free space clears the threshold. This is where the real reclaim lives:
   *      each `models--org--name` weight set is tens of GB, and the volume — not
   *      the host prefetch dir — is what actually fills the VM. Evicted models
   *      simply re-download on their next benchmark.
   *
   * `keepModelId`, when provided, protects that model's weight set from eviction
   * so a deploy never deletes the very weights it is about to serve. Best-effort
   * throughout; a GC failure is logged, not thrown (never stops the VM, never
   * blocks deploy).
   *
   * `requiredModelGb`, when provided, is the estimated on-disk size of the
   * model about to be deployed (weights + headroom). The effective threshold
   * is `max(minFreeDiskGb, requiredModelGb)` — a static `minFreeDiskGb` floor
   * (default 80GB) silently under-reserves for large downloads (e.g. a 103GB
   * FP8 MoE model), leaving too little free space for the download to
   * complete and stalling the deploy with "no space left on device" deep
   * inside model loading, well past this preflight check.
   */
  async ensureDiskSpace(
    sshConfig: SSHConfig,
    keepModelId?: string,
    requiredModelGb?: number | null,
  ): Promise<void> {
    // minFreeDiskGb <= 0 is the explicit opt-out — honor it regardless of the
    // estimated model size.
    if (this.options.minFreeDiskGb <= 0) return;
    const minFreeGb = Math.max(
      this.options.minFreeDiskGb,
      requiredModelGb && requiredModelGb > 0 ? requiredModelGb : 0,
    );

    const before = await this.readFreeDiskGb(sshConfig);
    if (before === null) {
      this.logger.debug('ensureDiskSpace: could not read free disk — skipping GC');
      return;
    }
    if (before >= minFreeGb) {
      this.logger.debug('ensureDiskSpace: sufficient free disk', { freeGb: before, minFreeGb });
      return;
    }

    this.logger.warn('ensureDiskSpace: low disk — running pre-deploy GC', {
      freeGb: before,
      minFreeGb,
    });

    try {
      await this.execSSH(sshConfig, 'docker system prune -f', 120_000);
    } catch (err) {
      this.logger.warn('ensureDiskSpace: docker prune failed (continuing)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let after = await this.readFreeDiskGb(sshConfig);
    if (after !== null && after < minFreeGb) {
      // Escalate: clear the host prefetch cache (never the weights volume).
      const hubPath = this.options.useSudo
        ? '/root/.cache/huggingface/hub'
        : '"$HOME"/.cache/huggingface/hub';
      try {
        await this.execSSH(sshConfig, `rm -rf ${hubPath}`, 120_000);
        this.logger.info('ensureDiskSpace: cleared host HuggingFace prefetch cache', { hubPath });
      } catch (err) {
        this.logger.warn('ensureDiskSpace: failed to clear host HF cache (continuing)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      after = await this.readFreeDiskGb(sshConfig);
    }

    if (after !== null && after < minFreeGb) {
      // Final escalation: LRU-evict the oldest cached model weight sets from the
      // shared volume until free space clears the threshold. This is the reclaim
      // that actually moves the needle (steps 1–2 rarely free more than a few GB).
      after = await this.evictOldestCachedModels(sshConfig, minFreeGb, after, keepModelId);
    }

    this.logger.info('ensureDiskSpace: GC complete', {
      freeGbBefore: before,
      freeGbAfter: after,
      minFreeGb,
      stillLow: after !== null && after < minFreeGb,
    });
  }

  /**
   * LRU-evict cached model weight sets from the `vllm-hf-cache` docker volume,
   * oldest access-time first, deleting one at a time and re-checking free disk
   * after each until it clears `minFreeGb` (or nothing is left to evict). The
   * model named by `keepModelId` is never evicted. Best-effort: any failure is
   * logged and the current free-disk reading is returned unchanged.
   *
   * HuggingFace stores each repo under `<mount>/hub/models--<org>--<name>` (the
   * repo id with `/` replaced by `--`), so the keep-dir is derived by the same
   * transform.
   */
  private async evictOldestCachedModels(
    sshConfig: SSHConfig,
    minFreeGb: number,
    currentFreeGb: number | null,
    keepModelId?: string,
  ): Promise<number | null> {
    const volume = this.options.hfCacheVolume;
    if (!volume) return currentFreeGb;

    let mountpoint: string;
    try {
      const mp = await this.execSSH(
        sshConfig,
        `docker volume inspect -f '{{.Mountpoint}}' ${volume}`,
        20_000,
      );
      mountpoint = mp.stdout.trim();
      if (!mountpoint) return currentFreeGb;
    } catch (err) {
      this.logger.warn('ensureDiskSpace: could not resolve HF cache volume mountpoint', {
        volume,
        error: err instanceof Error ? err.message : String(err),
      });
      return currentFreeGb;
    }

    const hubDir = `${mountpoint}/hub`;
    // Oldest-access-time first (`-tr`), one dir per line. Absolute paths (`-d` on
    // the glob) so deletion targets are unambiguous.
    let dirs: string[];
    try {
      const listing = await this.execSSH(
        sshConfig,
        `ls -1d -tr --time=atime ${hubDir}/models--* 2>/dev/null || true`,
        30_000,
      );
      dirs = listing.stdout
        .split('\n')
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
    } catch (err) {
      this.logger.warn('ensureDiskSpace: could not list cached models for eviction', {
        error: err instanceof Error ? err.message : String(err),
      });
      return currentFreeGb;
    }

    const keepDir = keepModelId ? `models--${keepModelId.replace(/\//g, '--')}` : null;
    let free = currentFreeGb;

    for (const dir of dirs) {
      if (free !== null && free >= minFreeGb) break;
      const base = dir.split('/').pop() ?? '';
      if (keepDir && base === keepDir) {
        this.logger.debug('ensureDiskSpace: skipping keep model during eviction', { dir: base });
        continue;
      }
      try {
        await this.execSSH(sshConfig, `rm -rf ${dir}`, 180_000);
        const freed = await this.readFreeDiskGb(sshConfig);
        this.logger.info('ensureDiskSpace: evicted cached model to reclaim disk', {
          model: base,
          freeGbAfter: freed,
          minFreeGb,
        });
        free = freed;
      } catch (err) {
        this.logger.warn('ensureDiskSpace: failed to evict cached model (continuing)', {
          model: base,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return free;
  }

  /**
   * Pre-fetch model weights on the GPU VM so vLLM cold-start is near-instant.
   * Fires-and-forgets (does not block caller). Logs errors but never throws.
   */
  async prefetchWeights(sshConfig: SSHConfig, modelId: string): Promise<void> {
    try {
      this.logger.info('Pre-fetching model weights in background', { modelId });
      await this.execSSH(
        sshConfig,
        `nohup bash -c 'huggingface-cli download ${modelId} --quiet' >/dev/null 2>&1 &`,
        15_000,
        modelId,
      );
    } catch (error) {
      this.logger.warn('prefetchWeights: failed to start background download', {
        modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
