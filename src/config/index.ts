import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { ZodError } from 'zod';
import { appConfigSchema } from '../types/config.js';
import type { AppConfig } from '../types/config.js';
import { defaultHardwareProfileRegistry } from '../services/hardware-profiles.js';
import type { HardwareProfileRegistry } from '../services/hardware-profiles.js';

/**
 * Options for loading configuration
 */
export interface LoadConfigOptions {
  /** Path to a JSON config file to load. Defaults to config/default.json if it exists. */
  configPath?: string;
  /** Whether to skip loading environment variables from .env file */
  skipDotenv?: boolean;
  /** Optional hardware profile registry. Defaults to the built-in registry. */
  profileRegistry?: HardwareProfileRegistry;
}

/**
 * Loads a JSON configuration file from disk.
 * Returns an empty object if the file does not exist or cannot be parsed.
 */
export function loadConfigFile(configPath: string): Record<string, unknown> {
  const resolvedPath = resolve(configPath);
  if (!existsSync(resolvedPath)) {
    return {};
  }

  const content = readFileSync(resolvedPath, 'utf-8');
  const parsed: unknown = JSON.parse(content);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file at ${resolvedPath} must contain a JSON object`);
  }

  return parsed as Record<string, unknown>;
}

/**
 * Builds a raw configuration object from environment variables.
 * Only includes values that are explicitly set in the environment.
 */
function buildEnvConfig(): Record<string, unknown> {
  const env: Record<string, unknown> = {};

  // SSH config from env vars
  const ssh: Record<string, unknown> = {};
  if (process.env['SSH_HOST'] !== undefined) ssh['host'] = process.env['SSH_HOST'];
  if (process.env['SSH_PORT'] !== undefined) ssh['port'] = Number(process.env['SSH_PORT']);
  if (process.env['SSH_USERNAME'] !== undefined) ssh['username'] = process.env['SSH_USERNAME'];
  if (process.env['SSH_PASSWORD'] !== undefined) ssh['password'] = process.env['SSH_PASSWORD'];
  if (process.env['SSH_PRIVATE_KEY_PATH'] !== undefined)
    ssh['privateKeyPath'] = process.env['SSH_PRIVATE_KEY_PATH'];
  if (process.env['SSH_USE_SUDO'] !== undefined)
    ssh['useSudo'] = process.env['SSH_USE_SUDO'] === 'true';
  if (Object.keys(ssh).length > 0) env['ssh'] = ssh;

  // HuggingFace token
  if (process.env['HUGGINGFACE_TOKEN'] !== undefined)
    env['huggingfaceToken'] = process.env['HUGGINGFACE_TOKEN'];

  // Benchmark thresholds from env vars
  const thresholds: Record<string, unknown> = {};
  if (process.env['MIN_CONTEXT_WINDOW'] !== undefined)
    thresholds['minContextWindow'] = Number(process.env['MIN_CONTEXT_WINDOW']);
  if (process.env['MAX_ITL_MS'] !== undefined)
    thresholds['maxITLMs'] = Number(process.env['MAX_ITL_MS']);
  if (process.env['MAX_TOOL_CALL_LATENCY_MS'] !== undefined)
    thresholds['maxToolCallLatencyMs'] = Number(process.env['MAX_TOOL_CALL_LATENCY_MS']);
  if (process.env['MIN_TOOL_CALL_SUCCESS_RATE'] !== undefined)
    thresholds['minToolCallSuccessRate'] = Number(process.env['MIN_TOOL_CALL_SUCCESS_RATE']);
  if (process.env['CONCURRENCY_LEVELS'] !== undefined)
    thresholds['concurrencyLevels'] = process.env['CONCURRENCY_LEVELS'].split(',').map(Number);
  if (process.env['HEALTH_CHECK_TIMEOUT_SECONDS'] !== undefined)
    thresholds['healthCheckTimeoutSeconds'] = Number(process.env['HEALTH_CHECK_TIMEOUT_SECONDS']);
  if (Object.keys(thresholds).length > 0) env['benchmarkThresholds'] = thresholds;

  // VM hardware profile from env vars
  const hardware: Record<string, unknown> = {};
  if (process.env['VM_GPU_TYPE'] !== undefined) hardware['gpuType'] = process.env['VM_GPU_TYPE'];
  if (process.env['VM_GPU_COUNT'] !== undefined)
    hardware['gpuCount'] = Number(process.env['VM_GPU_COUNT']);
  if (process.env['VM_RAM_GB'] !== undefined) hardware['ramGb'] = Number(process.env['VM_RAM_GB']);
  if (process.env['VM_CPU_CORES'] !== undefined)
    hardware['cpuCores'] = Number(process.env['VM_CPU_CORES']);
  if (process.env['VM_DISK_GB'] !== undefined)
    hardware['diskGb'] = Number(process.env['VM_DISK_GB']);
  if (process.env['VM_MACHINE_TYPE'] !== undefined)
    hardware['machineType'] = process.env['VM_MACHINE_TYPE'];
  if (Object.keys(hardware).length > 0) env['vmHardwareProfile'] = hardware;

  // Hardware profile ID
  if (process.env['HARDWARE_PROFILE_ID'] !== undefined)
    env['hardwareProfileId'] = process.env['HARDWARE_PROFILE_ID'];

  // Application settings
  if (process.env['LOG_LEVEL'] !== undefined) env['logLevel'] = process.env['LOG_LEVEL'];
  if (process.env['RESULTS_DIR'] !== undefined) env['resultsDir'] = process.env['RESULTS_DIR'];

  // Daemon configuration from env vars
  const daemon: Record<string, unknown> = {};
  if (process.env['DAEMON_ENABLED'] !== undefined)
    daemon['enabled'] = process.env['DAEMON_ENABLED'] === 'true';
  if (process.env['DAEMON_SLEEP_INTERVAL_MS'] !== undefined)
    daemon['sleepIntervalMs'] = Number(process.env['DAEMON_SLEEP_INTERVAL_MS']);
  if (process.env['DAEMON_MAX_CONSECUTIVE_ERRORS'] !== undefined)
    daemon['maxConsecutiveErrors'] = Number(process.env['DAEMON_MAX_CONSECUTIVE_ERRORS']);
  if (process.env['DAEMON_MAX_CYCLES'] !== undefined)
    daemon['maxCycles'] = Number(process.env['DAEMON_MAX_CYCLES']);
  if (process.env['DAEMON_RECURSION_LIMIT'] !== undefined)
    daemon['recursionLimit'] = Number(process.env['DAEMON_RECURSION_LIMIT']);
  if (process.env['DAEMON_STATE_FILE_PATH'] !== undefined)
    daemon['stateFilePath'] = process.env['DAEMON_STATE_FILE_PATH'];
  if (process.env['DAEMON_ERROR_BACKOFF_MULTIPLIER'] !== undefined)
    daemon['errorBackoffMultiplier'] = Number(process.env['DAEMON_ERROR_BACKOFF_MULTIPLIER']);
  if (process.env['DAEMON_MAX_SLEEP_INTERVAL_MS'] !== undefined)
    daemon['maxSleepIntervalMs'] = Number(process.env['DAEMON_MAX_SLEEP_INTERVAL_MS']);
  if (Object.keys(daemon).length > 0) env['daemon'] = daemon;

  // Tunnel configuration from env vars
  const tunnel: Record<string, unknown> = {};
  if (process.env['TUNNEL_ENABLED'] !== undefined)
    tunnel['enabled'] = process.env['TUNNEL_ENABLED'] === 'true';
  if (process.env['TUNNEL_PROVIDER'] !== undefined)
    tunnel['provider'] = process.env['TUNNEL_PROVIDER'];
  if (process.env['NGROK_AUTH_TOKEN'] !== undefined)
    tunnel['ngrokAuthToken'] = process.env['NGROK_AUTH_TOKEN'];
  if (process.env['NGROK_REGION'] !== undefined)
    tunnel['ngrokRegion'] = process.env['NGROK_REGION'];
  if (process.env['TUNNEL_LOCAL_PORT'] !== undefined)
    tunnel['localPort'] = Number(process.env['TUNNEL_LOCAL_PORT']);
  if (process.env['NGROK_DOMAIN'] !== undefined)
    tunnel['ngrokDomain'] = process.env['NGROK_DOMAIN'];
  if (process.env['TUNNEL_TIMEOUT_MS'] !== undefined)
    tunnel['timeoutMs'] = Number(process.env['TUNNEL_TIMEOUT_MS']);
  if (process.env['TUNNEL_RETRY_ATTEMPTS'] !== undefined)
    tunnel['retryAttempts'] = Number(process.env['TUNNEL_RETRY_ATTEMPTS']);
  if (process.env['TUNNEL_RETRY_DELAY_MS'] !== undefined)
    tunnel['retryDelayMs'] = Number(process.env['TUNNEL_RETRY_DELAY_MS']);
  if (Object.keys(tunnel).length > 0) env['tunnel'] = tunnel;

  // Engine configuration from env vars
  const engine: Record<string, unknown> = {};
  if (process.env['ENGINE_TYPE'] !== undefined)
    engine['type'] = process.env['ENGINE_TYPE'];
  if (process.env['ENGINE_API_PORT'] !== undefined)
    engine['apiPort'] = Number(process.env['ENGINE_API_PORT']);
  if (process.env['ENGINE_DOCKER_IMAGE'] !== undefined)
    engine['dockerImage'] = process.env['ENGINE_DOCKER_IMAGE'];
  if (process.env['OLLAMA_USE_DOCKER'] !== undefined)
    engine['ollamaUseDocker'] = process.env['OLLAMA_USE_DOCKER'] === 'true';
  if (process.env['OLLAMA_NUM_GPU_LAYERS'] !== undefined)
    engine['ollamaNumGpuLayers'] = Number(process.env['OLLAMA_NUM_GPU_LAYERS']);
  if (process.env['VLLM_GPU_MEMORY_UTILIZATION'] !== undefined)
    engine['vllmGpuMemoryUtilization'] = Number(process.env['VLLM_GPU_MEMORY_UTILIZATION']);
  if (process.env['ENGINE_MAX_MODEL_LEN'] !== undefined)
    engine['maxModelLen'] = Number(process.env['ENGINE_MAX_MODEL_LEN']);
  if (Object.keys(engine).length > 0) env['engine'] = engine;

  const elasticsearch: Record<string, unknown> = {};
  if (process.env['ELASTICSEARCH_URL'] !== undefined)
    elasticsearch['url'] = process.env['ELASTICSEARCH_URL'];
  if (process.env['ELASTICSEARCH_API_KEY'] !== undefined)
    elasticsearch['apiKey'] = process.env['ELASTICSEARCH_API_KEY'];
  if (process.env['ELASTICSEARCH_CLOUD_ID'] !== undefined)
    elasticsearch['cloudId'] = process.env['ELASTICSEARCH_CLOUD_ID'];
  if (Object.keys(elasticsearch).length > 0) env['elasticsearch'] = elasticsearch;

  const elasticAgent: Record<string, unknown> = {};
  if (process.env['ELASTIC_AGENT_ENABLED'] !== undefined)
    elasticAgent['enabled'] = process.env['ELASTIC_AGENT_ENABLED'] === 'true';
  if (process.env['ELASTIC_AGENT_FLEET_URL'] !== undefined)
    elasticAgent['fleetUrl'] = process.env['ELASTIC_AGENT_FLEET_URL'];
  if (process.env['ELASTIC_AGENT_ENROLLMENT_TOKEN'] !== undefined)
    elasticAgent['enrollmentToken'] = process.env['ELASTIC_AGENT_ENROLLMENT_TOKEN'];
  if (process.env['ELASTIC_AGENT_MODE'] !== undefined)
    elasticAgent['mode'] = process.env['ELASTIC_AGENT_MODE'];
  if (Object.keys(elasticAgent).length > 0) env['elasticAgent'] = elasticAgent;

  // Kibana connector configuration from env vars
  const kibanaConnector: Record<string, unknown> = {};
  if (process.env['KIBANA_CONNECTOR_ENABLED'] !== undefined)
    kibanaConnector['enabled'] = process.env['KIBANA_CONNECTOR_ENABLED'] === 'true';
  if (process.env['KIBANA_CONNECTOR_URL'] !== undefined)
    kibanaConnector['url'] = process.env['KIBANA_CONNECTOR_URL'];
  if (process.env['KIBANA_CONNECTOR_API_KEY'] !== undefined)
    kibanaConnector['apiKey'] = process.env['KIBANA_CONNECTOR_API_KEY'];
  if (process.env['KIBANA_CONNECTOR_NAME_PREFIX'] !== undefined)
    kibanaConnector['connectorNamePrefix'] = process.env['KIBANA_CONNECTOR_NAME_PREFIX'];
  if (process.env['KIBANA_CONNECTOR_REQUEST_TIMEOUT_MS'] !== undefined)
    kibanaConnector['requestTimeoutMs'] = Number(process.env['KIBANA_CONNECTOR_REQUEST_TIMEOUT_MS']);
  if (Object.keys(kibanaConnector).length > 0) env['kibanaConnector'] = kibanaConnector;

  // Notification configuration from env vars
  const notifications: Record<string, unknown> = {};
  if (process.env['NOTIFICATIONS_ENABLED'] !== undefined)
    notifications['enabled'] = process.env['NOTIFICATIONS_ENABLED'] === 'true';
  if (process.env['NOTIFICATIONS_MIN_LEVEL'] !== undefined)
    notifications['minLevel'] = process.env['NOTIFICATIONS_MIN_LEVEL'];

  // Notification console channel
  const notifConsole: Record<string, unknown> = {};
  if (process.env['NOTIFICATIONS_CONSOLE_ENABLED'] !== undefined)
    notifConsole['enabled'] = process.env['NOTIFICATIONS_CONSOLE_ENABLED'] === 'true';
  if (Object.keys(notifConsole).length > 0) notifications['console'] = notifConsole;

  // Notification file channel
  const notifFile: Record<string, unknown> = {};
  if (process.env['NOTIFICATIONS_FILE_ENABLED'] !== undefined)
    notifFile['enabled'] = process.env['NOTIFICATIONS_FILE_ENABLED'] === 'true';
  if (process.env['NOTIFICATIONS_FILE_PATH'] !== undefined)
    notifFile['filePath'] = process.env['NOTIFICATIONS_FILE_PATH'];
  if (process.env['NOTIFICATIONS_FILE_JSON_FORMAT'] !== undefined)
    notifFile['jsonFormat'] = process.env['NOTIFICATIONS_FILE_JSON_FORMAT'] === 'true';
  if (Object.keys(notifFile).length > 0) notifications['file'] = notifFile;

  // Notification webhook channel
  const notifWebhook: Record<string, unknown> = {};
  if (process.env['NOTIFICATIONS_WEBHOOK_ENABLED'] !== undefined)
    notifWebhook['enabled'] = process.env['NOTIFICATIONS_WEBHOOK_ENABLED'] === 'true';
  if (process.env['NOTIFICATIONS_WEBHOOK_URL'] !== undefined)
    notifWebhook['url'] = process.env['NOTIFICATIONS_WEBHOOK_URL'];
  if (process.env['NOTIFICATIONS_WEBHOOK_FORMAT'] !== undefined)
    notifWebhook['format'] = process.env['NOTIFICATIONS_WEBHOOK_FORMAT'];
  if (process.env['NOTIFICATIONS_WEBHOOK_TIMEOUT_MS'] !== undefined)
    notifWebhook['timeoutMs'] = Number(process.env['NOTIFICATIONS_WEBHOOK_TIMEOUT_MS']);
  if (Object.keys(notifWebhook).length > 0) notifications['webhook'] = notifWebhook;

  // Notification email channel
  const notifEmail: Record<string, unknown> = {};
  if (process.env['NOTIFICATIONS_EMAIL_ENABLED'] !== undefined)
    notifEmail['enabled'] = process.env['NOTIFICATIONS_EMAIL_ENABLED'] === 'true';
  if (process.env['NOTIFICATIONS_EMAIL_HOST'] !== undefined)
    notifEmail['host'] = process.env['NOTIFICATIONS_EMAIL_HOST'];
  if (process.env['NOTIFICATIONS_EMAIL_PORT'] !== undefined)
    notifEmail['port'] = Number(process.env['NOTIFICATIONS_EMAIL_PORT']);
  if (process.env['NOTIFICATIONS_EMAIL_SECURE'] !== undefined)
    notifEmail['secure'] = process.env['NOTIFICATIONS_EMAIL_SECURE'] === 'true';
  if (process.env['NOTIFICATIONS_EMAIL_USERNAME'] !== undefined)
    notifEmail['username'] = process.env['NOTIFICATIONS_EMAIL_USERNAME'];
  if (process.env['NOTIFICATIONS_EMAIL_PASSWORD'] !== undefined)
    notifEmail['password'] = process.env['NOTIFICATIONS_EMAIL_PASSWORD'];
  if (process.env['NOTIFICATIONS_EMAIL_FROM'] !== undefined)
    notifEmail['from'] = process.env['NOTIFICATIONS_EMAIL_FROM'];
  if (process.env['NOTIFICATIONS_EMAIL_TO'] !== undefined)
    notifEmail['to'] = process.env['NOTIFICATIONS_EMAIL_TO'].split(',').map((s) => s.trim());
  if (Object.keys(notifEmail).length > 0) notifications['email'] = notifEmail;

  if (Object.keys(notifications).length > 0) env['notifications'] = notifications;

  return env;
}

/**
 * Deep-merges two plain objects. Source values override target values.
 * Arrays are replaced entirely (not merged element-by-element).
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];

    if (
      typeof sourceVal === 'object' &&
      sourceVal !== null &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === 'object' &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}

/**
 * Formats Zod validation errors into human-readable messages.
 */
export function formatValidationErrors(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * Resolves a hardware profile ID to its hardware configuration.
 *
 * When a `hardwareProfileId` is specified, the profile's hardware values
 * are used as the base, and any explicit vmHardwareProfile values override them.
 *
 * @param config - The merged config object (may contain hardwareProfileId and vmHardwareProfile)
 * @param registry - The hardware profile registry to look up profiles
 * @returns The config with vmHardwareProfile resolved from the profile
 */
function resolveHardwareProfile(
  config: Record<string, unknown>,
  registry: HardwareProfileRegistry,
): Record<string, unknown> {
  const profileId = config['hardwareProfileId'];
  if (typeof profileId !== 'string' || profileId.length === 0) {
    return config;
  }

  const profile = registry.getProfile(profileId);
  if (!profile) {
    throw new Error(
      `Unknown hardware profile ID: '${profileId}'. ` +
      `Available profiles: ${registry.getProfileIds().join(', ')}`,
    );
  }

  // Use the profile's hardware as the base, then merge any explicit overrides
  const profileHardware = JSON.parse(JSON.stringify(profile.hardware)) as Record<string, unknown>;
  const existingHardware = (config['vmHardwareProfile'] ?? {}) as Record<string, unknown>;
  const mergedHardware = deepMerge(profileHardware, existingHardware);

  return {
    ...config,
    vmHardwareProfile: mergedHardware,
  };
}

/**
 * Loads and validates application configuration from multiple sources.
 *
 * Configuration is loaded and merged in the following priority order (highest wins):
 * 1. Programmatic overrides (passed as parameter)
 * 2. Environment variables (from process.env and .env file)
 * 3. Hardware profile defaults (when hardwareProfileId is set)
 * 4. JSON config file (config/default.json or custom path)
 * 5. Schema defaults (defined in Zod schemas)
 *
 * When a `hardwareProfileId` is specified (via config file, env var, or overrides),
 * the corresponding hardware profile's values are used as defaults for `vmHardwareProfile`.
 * Individual hardware fields can still be overridden.
 *
 * @param overrides - Programmatic configuration overrides
 * @param options - Options for config loading behavior
 * @returns Validated application configuration
 * @throws {Error} If configuration validation fails, with descriptive error messages
 * @throws {Error} If the specified hardware profile ID is not found
 */
export function loadConfig(overrides?: Partial<AppConfig>, options?: LoadConfigOptions): AppConfig {
  if (!options?.skipDotenv) {
    dotenv.config();
  }

  // Layer 1: Load JSON config file
  const configPath = options?.configPath ?? 'config/default.json';
  const fileConfig = loadConfigFile(configPath);

  // Layer 2: Build config from environment variables
  const envConfig = buildEnvConfig();

  // Layer 3: Deep-merge layers (file < env < overrides)
  let mergedConfig = deepMerge(fileConfig, envConfig);

  if (overrides) {
    // Convert overrides to plain object for merging
    const overridesObj = JSON.parse(JSON.stringify(overrides)) as Record<string, unknown>;
    mergedConfig = deepMerge(mergedConfig, overridesObj);
  }

  // Layer 4: Resolve hardware profile ID to hardware configuration
  const registry = options?.profileRegistry ?? defaultHardwareProfileRegistry;
  mergedConfig = resolveHardwareProfile(mergedConfig, registry);

  // Validate and return
  try {
    return appConfigSchema.parse(mergedConfig);
  } catch (err) {
    if (err instanceof ZodError) {
      const messages = formatValidationErrors(err);
      throw new Error(`Configuration validation failed:\n  - ${messages.join('\n  - ')}`);
    }
    throw err;
  }
}
