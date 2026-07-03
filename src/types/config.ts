import { z } from 'zod';

/**
 * SSH connection configuration for GCP VM access.
 * Requires either a password or privateKeyPath for authentication.
 */
export const sshConfigSchema = z
  .object({
    host: z.string().min(1, 'SSH host is required'),
    port: z.number().int().positive().default(22),
    username: z.string().min(1, 'SSH username is required'),
    password: z.string().min(1).optional(),
    privateKeyPath: z.string().min(1).optional(),
    passphrase: z.string().min(1).optional(),
    /** Whether to run Docker commands with sudo (default: false) */
    useSudo: z.boolean().default(false),
  })
  .refine((data) => data.password !== undefined || data.privateKeyPath !== undefined, {
    message: 'Either SSH password or privateKeyPath must be provided',
    path: ['password'],
  });

/**
 * Single tier for parameter-count-based ITL thresholds.
 * First tier where parameterCountBillions <= maxParamsBillions applies.
 */
export const itlTierSchema = z.object({
  maxParamsBillions: z.number().positive(),
  maxITLMs: z.number().positive(),
});

/**
 * Benchmark threshold configuration for model evaluation criteria
 */
export const benchmarkThresholdsSchema = z.object({
  minContextWindow: z.number().int().positive().default(128_000),
  /** Legacy flat max ITL (used when model param count is unknown) */
  maxITLMs: z.number().positive().default(20),
  /** Tiered ITL thresholds by model size (param count in billions) */
  maxITLMsTiers: z.array(itlTierSchema).default([
    { maxParamsBillions: 14, maxITLMs: 20 },
    { maxParamsBillions: 40, maxITLMs: 40 },
    { maxParamsBillions: 80, maxITLMs: 60 },
    { maxParamsBillions: Infinity, maxITLMs: 100 },
  ]),
  maxToolCallLatencyMs: z.number().positive().default(1000),
  minToolCallSuccessRate: z.number().min(0).max(1).default(1.0),
  concurrencyLevels: z.array(z.number().int().positive()).default([1, 4, 16]),
  healthCheckTimeoutSeconds: z.number().int().positive().default(1800),
});

/**
 * Stage 2 thresholds for the gate between Stage 1 and Stage 2 benchmarks.
 */
export const stage2ThresholdsSchema = z.object({
  /** Maximum inter-token latency p50 (ms), used when model param count is unknown. Lower is better. */
  maxItlP50Ms: z.number().positive().default(20),
  /**
   * Tiered ITL p50 caps by model size (param count in billions). Larger models are
   * inherently slower per token, so a flat 20ms cap excludes every 14B+ model from
   * CI-eval eligibility. Mirrors benchmarkThresholds.maxITLMsTiers so a model that
   * passes Stage 1 at its tier is also eligible for Stage 2 at the same tier.
   */
  maxItlP50MsTiers: z.array(itlTierSchema).default([
    { maxParamsBillions: 14, maxITLMs: 20 },
    { maxParamsBillions: 40, maxITLMs: 40 },
    { maxParamsBillions: 80, maxITLMs: 60 },
    { maxParamsBillions: Infinity, maxITLMs: 100 },
  ]),
  minThroughputTps: z.number().positive().default(10),
  maxTtftMs: z.number().positive().default(5000),
  minContextWindow: z.number().int().positive().default(128_000),
});

/**
 * VM hardware profile configuration describing the GCP VM resources
 */
export const vmHardwareProfileSchema = z.object({
  gpuType: z.string().default('nvidia-a100-80gb'),
  gpuCount: z.number().int().positive().default(2),
  ramGb: z.number().positive().default(340),
  cpuCores: z.number().int().positive().default(24),
  diskGb: z.number().int().positive().default(1000),
  machineType: z.string().default('a2-ultragpu-2g'),
});

/**
 * Schedule window configuration for the daemon.
 * Defines a time window during which the daemon should pause.
 * Hours are in 24-hour format (0-23).
 */
export const scheduleWindowSchema = z.object({
  /** Hour to start pausing (0-23, inclusive) */
  startHour: z.number().int().min(0).max(23),
  /** Hour to stop pausing (0-23, exclusive) */
  endHour: z.number().int().min(0).max(23),
  /** Days of the week to apply this window (0=Sunday, 6=Saturday). Empty means all days. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
});

/**
 * Daemon configuration for the continuous runner.
 *
 * Controls the behavior of the long-running daemon process that
 * repeatedly executes benchmark cycles with configurable sleep
 * intervals, scheduling, and error recovery.
 */
export const daemonConfigSchema = z.object({
  /** Whether the daemon is enabled. Defaults to false. */
  enabled: z.boolean().default(false),
  /** Sleep interval in milliseconds between benchmark cycles. Defaults to 60000 (1 minute). */
  sleepIntervalMs: z.number().int().positive().default(60_000),
  /** Maximum consecutive cycle errors before the daemon stops. Defaults to 10. */
  maxConsecutiveErrors: z.number().int().positive().default(10),
  /** Maximum number of benchmark cycles to run (0 = unlimited). Defaults to 0. */
  maxCycles: z.number().int().min(0).default(0),
  /** Recursion limit per agent run (controls how many graph steps per cycle). Defaults to 25. */
  recursionLimit: z.number().int().positive().default(25),
  /** Path to the daemon state file for persistence across restarts. */
  stateFilePath: z.string().default('./data/daemon-state.json'),
  /** Time windows during which the daemon should pause (e.g., off-peak hours). */
  pauseWindows: z.array(scheduleWindowSchema).default([]),
  /** Backoff multiplier for sleep interval after consecutive errors. Defaults to 1.5. */
  errorBackoffMultiplier: z.number().positive().default(1.5),
  /** Maximum sleep interval in ms after error backoff. Defaults to 300000 (5 minutes). */
  maxSleepIntervalMs: z.number().int().positive().default(300_000),
});

/**
 * Tunnel provider type for exposing the vLLM API publicly.
 *
 * - `ngrok`: reserved-domain agent (fragile on free tier — single reserved
 *   domain, sticky cloud-side endpoints cause ERR_NGROK_334 collisions).
 * - `cloudflared`: Cloudflare quick tunnels — ephemeral `*.trycloudflare.com`
 *   URL per run, no account/domain/reservation, so it cannot collide with a
 *   stale endpoint. Preferred for unattended autonomous runs.
 * - `cloudrun` / `load_balancer`: future GCP-native options (not implemented).
 */
export const tunnelProviderSchema = z.enum([
  'ngrok',
  'cloudflared',
  'cloudrun',
  'load_balancer',
]);

/**
 * Tunnel configuration for exposing the vLLM API publicly.
 *
 * When enabled, the tunnel service will create a public URL that
 * forwards traffic to the local vLLM API endpoint. This URL is
 * stored in the benchmark results for Kibana connector creation.
 */
export const tunnelConfigSchema = z.object({
  /** Whether tunneling is enabled. Defaults to false. */
  enabled: z.boolean().default(false),
  /** Tunnel provider to use. Defaults to 'ngrok'. */
  provider: tunnelProviderSchema.default('ngrok'),
  /** ngrok authentication token. Required when provider is 'ngrok' and enabled is true. */
  ngrokAuthToken: z.string().optional(),
  /** ngrok region (us, eu, ap, au, sa, jp, in). Defaults to 'us'. */
  ngrokRegion: z.string().default('us'),
  /** Local port to tunnel (typically the vLLM API port). Defaults to 8000. */
  localPort: z.number().int().positive().default(8000),
  /** Optional custom domain for ngrok (requires paid plan). */
  ngrokDomain: z.string().optional(),
  /** Timeout in milliseconds for tunnel establishment. Defaults to 30000 (30 sec). */
  timeoutMs: z.number().int().positive().default(30_000),
  /** Number of retry attempts for tunnel creation. Defaults to 3. */
  retryAttempts: z.number().int().min(0).default(3),
  /** Delay in milliseconds between retry attempts. Defaults to 5000 (5 sec). */
  retryDelayMs: z.number().int().positive().default(5_000),
});

/**
 * Kibana connector configuration for creating connectors to the exposed vLLM endpoint.
 *
 * When enabled, the Kibana connector service will create an OpenAI-compatible
 * connector in Kibana that points to the vLLM API (via tunnel URL or direct endpoint).
 * This enables the Agent builder LLM features evaluation workflow.
 */
export const kibanaConnectorConfigSchema = z.object({
  /** Whether Kibana connector creation is enabled. Defaults to false. */
  enabled: z.boolean().default(false),
  /** Kibana instance URL (e.g., 'https://my-deployment.kb.us-central1.gcp.cloud.es.io:9243'). */
  url: z.string().url().optional(),
  /** Kibana API key for authentication. Required when enabled is true. */
  apiKey: z.string().optional(),
  /** Default connector name prefix. The model ID will be appended. Defaults to 'vllm-'. */
  connectorNamePrefix: z.string().default('vllm-'),
  /** Timeout in milliseconds for Kibana API requests. Defaults to 30000 (30 sec). */
  requestTimeoutMs: z.number().int().positive().default(30_000),
});

/**
 * Kibana evaluation runner configuration for testing models via
 * Kibana's Agent builder features.
 *
 * Controls evaluation tasks, scoring thresholds, and test parameters.
 * The evaluation runner is automatically enabled when the Kibana connector is enabled.
 */
export const kibanaEvalConfigSchema = z.object({
  /** Whether the Kibana evaluation runner is enabled. Defaults to true. */
  enabled: z.boolean().default(true),
  /** Score threshold (0-100) for PASS classification. Defaults to 80. */
  passThreshold: z.number().min(0).max(100).default(80),
  /** Global timeout for the entire evaluation in milliseconds. Defaults to 120000 (2 min). */
  globalTimeoutMs: z.number().int().positive().default(120_000),
  /** Whether to continue running remaining tasks after a critical failure. Defaults to false. */
  continueOnCriticalFailure: z.boolean().default(false),
  /** Test prompt for chat completion evaluation. */
  testPrompt: z.string().default('What is 2 + 2? Answer with just the number.'),
  /** Expected keywords in chat completion response for basic validation. */
  expectedResponseKeywords: z.array(z.string()).default(['4']),
  /** Tool name for tool calling evaluation. */
  toolCallTestToolName: z.string().default('get_current_time'),
  /** Tool prompt for tool calling evaluation. */
  toolCallTestPrompt: z.string().default('What is the current time? Use the get_current_time tool.'),
});

/**
 * Supported inference engine type.
 * VLLM Docker-based deployment (default, production-ready).
 */
export const engineTypeSchema = z.enum(['vllm']);

/**
 * Engine-specific configuration schema.
 *
 * Provides optional overrides for engine-specific settings.
 * When not provided, sensible defaults are used per engine type.
 */
export const engineConfigSchema = z.object({
  /** Inference engine type to use. Defaults to 'vllm'. */
  type: engineTypeSchema.default('vllm'),
  /** API port for the inference engine (default: 8000) */
  apiPort: z.number().int().positive().optional(),
  /** Docker image override for the engine */
  dockerImage: z.string().optional(),
  /** GPU memory utilization fraction for vLLM (default: 0.95) */
  vllmGpuMemoryUtilization: z.number().min(0).max(1).default(0.95),
  /** Maximum model length override (optional, engine auto-detects) */
  maxModelLen: z.number().int().positive().optional(),
});

/**
 * Notification level schema.
 */
export const notificationLevelSchema = z.enum(['info', 'warn', 'error', 'critical']);

/**
 * Notification event type schema.
 */
export const notificationEventTypeSchema = z.enum([
  'model_approved',
  'model_conditional',
  'model_rejected',
  'benchmark_error',
  'benchmark_started',
  'benchmark_completed',
  'deployment_error',
  'daily_summary',
  'daemon_started',
  'daemon_stopped',
  'daemon_max_errors',
  'daemon_max_cycles',
]);

/**
 * Webhook format schema for different integrations.
 */
export const webhookFormatSchema = z.enum(['slack', 'discord', 'generic']);

/**
 * Console channel configuration schema.
 */
export const consoleChannelConfigSchema = z.object({
  /** Whether this channel is enabled. Defaults to true. */
  enabled: z.boolean().default(true),
});

/**
 * File channel configuration schema.
 */
export const fileChannelConfigSchema = z.object({
  /** Whether this channel is enabled. Defaults to false. */
  enabled: z.boolean().default(false),
  /** Path to the notification log file. Defaults to './data/notifications.log'. */
  filePath: z.string().default('./data/notifications.log'),
  /** Whether to write in JSON format (JSONL). Defaults to true. */
  jsonFormat: z.boolean().default(true),
});

/**
 * Webhook channel configuration schema.
 */
export const webhookChannelConfigSchema = z.object({
  /** Whether this channel is enabled. Defaults to false. */
  enabled: z.boolean().default(false),
  /** Webhook URL to send notifications to. */
  url: z.string().url().optional(),
  /** Webhook payload format. Defaults to 'generic'. */
  format: webhookFormatSchema.default('generic'),
  /** Request timeout in milliseconds. Defaults to 10000 (10 seconds). */
  timeoutMs: z.number().int().positive().default(10_000),
  /** Number of retry attempts on failure. Defaults to 2. */
  retryAttempts: z.number().int().min(0).default(2),
  /** Delay between retries in milliseconds. Defaults to 1000. */
  retryDelayMs: z.number().int().positive().default(1_000),
});

/**
 * Email channel configuration schema.
 */
export const emailChannelConfigSchema = z.object({
  /** Whether this channel is enabled. Defaults to false. */
  enabled: z.boolean().default(false),
  /** SMTP server hostname. */
  host: z.string().optional(),
  /** SMTP server port. Defaults to 587. */
  port: z.number().int().positive().default(587),
  /** Whether to use TLS/SSL. Defaults to true. */
  secure: z.boolean().default(true),
  /** SMTP authentication username. */
  username: z.string().optional(),
  /** SMTP authentication password. */
  password: z.string().optional(),
  /** Email sender address. */
  from: z.string().optional(),
  /** Email recipient addresses (comma-separated string or array). */
  to: z.union([z.string(), z.array(z.string())]).default([]),
  /** Optional email subject prefix. Defaults to '[LLM Benchmarker]'. */
  subjectPrefix: z.string().default('[LLM Benchmarker]'),
});

/**
 * Notification system configuration schema.
 *
 * Configures the notification system's channels, filtering, and routing.
 * Supports console, file, webhook (Slack/Discord), and email channels.
 */
export const notificationConfigSchema = z.object({
  /** Whether the notification system is enabled. Defaults to false. */
  enabled: z.boolean().default(false),
  /**
   * Minimum notification level to process.
   * Events below this level will be filtered out.
   * Defaults to 'info' (all events).
   */
  minLevel: notificationLevelSchema.default('info'),
  /**
   * Event types to include. If specified, only these event types are processed.
   * Empty array means all events are included.
   */
  includeEvents: z.array(notificationEventTypeSchema).default([]),
  /**
   * Event types to exclude. These event types are filtered out.
   * Applied after includeEvents.
   */
  excludeEvents: z.array(notificationEventTypeSchema).default([]),
  /** Console channel configuration. */
  console: consoleChannelConfigSchema.default({}),
  /** File channel configuration. */
  file: fileChannelConfigSchema.default({}),
  /** Webhook channel configuration. */
  webhook: webhookChannelConfigSchema.default({}),
  /** Email channel configuration. */
  email: emailChannelConfigSchema.default({}),
});

export const elasticsearchConfigSchema = z.object({
  url: z.string().url().default('http://localhost:9200'),
  apiKey: z.string().optional(),
  cloudId: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});

export const elasticAgentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  fleetUrl: z.string().url().optional(),
  enrollmentToken: z.string().optional(),
  mode: z.enum(['fleet', 'standalone']).default('fleet'),
  policyId: z.string().optional(),
  version: z.string().default('9.5.0-SNAPSHOT'),
});

/**
 * Golden cluster configuration for centralized tracking.
 */
export const goldenClusterConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().url().default('https://kbn-evals-serverless-ed035a.kb.us-central1.gcp.elastic.cloud'),
  apiKey: z.string().optional(),
  forwardToGolden: z.boolean().default(false),
});

/**
 * EDOT collector configuration for OpenTelemetry trace collection.
 */
export const edotCollectorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  otlpEndpoint: z.string().url().default('http://localhost:4318'),
  healthEndpoint: z.string().url().default('http://localhost:8080/healthz'),
  traceIndexPattern: z.string().default('traces-*'),
  samplingRate: z.number().min(0).max(1).default(1.0),
  /**
   * OTLP endpoint that vLLM (running in a container on the remote GPU VM) pushes
   * traces to via `--otlp-traces-endpoint`. Resolved from the container's
   * perspective — typically `http://host.docker.internal:4317` with a reverse
   * SSH tunnel back to the local collector. Unset = no OTLP traces emitted.
   */
  vllmOtlpTracesEndpoint: z.string().url().optional(),
});

/**
 * Kibana repository configuration for cloning the Kibana main repo.
 */
const gitCloneUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith('https://') ||
      value.startsWith('http://') ||
      value.startsWith('git@'),
    { message: 'Must be an http(s):// or git@ clone URL' },
  );

export const kibanaRepoConfigSchema = z.object({
  url: gitCloneUrlSchema.default('https://github.com/elastic/kibana.git'),
  pinToCommit: z.string().optional(),
  pinToTag: z.string().optional(),
  clonePath: z.string().default('./.kibana-cache'),
  cacheDir: z.string().optional(),
  branch: z.string().default('main'),
  autoPull: z.boolean().default(true),
  bootstrapTimeoutMs: z.number().int().positive().default(1_800_000),
});

/**
 * Smoke test configuration for validating deployed models before CI eval triggers.
 */
export const smokeTestConfigSchema = z.object({
  /** Timeout for health check endpoint. */
  healthTimeoutMs: z.number().int().positive().default(10_000),
  /** Timeout for single inference request. */
  inferenceTimeoutMs: z.number().int().positive().default(30_000),
  /** Timeout for tool-calling request. */
  toolCallingTimeoutMs: z.number().int().positive().default(60_000),
  /** Number of retries per tier. */
  maxRetries: z.number().int().min(0).default(2),
  /** Smoke test depth: 'health', 'inference', or 'full' (includes tool calling). */
  depth: z.enum(['health', 'inference', 'full']).default('full'),
  /** Prompt for inference tier. */
  testPrompt: z.string().default('What is 2 + 2? Answer with just the number.'),
  /** Expected keywords in inference response. */
  expectedKeywords: z.array(z.string()).default(['4']),
  /** Tool name for tool-calling tier. */
  toolName: z.string().default('get_current_time'),
  /** Prompt for tool-calling tier. */
  toolPrompt: z.string().default('What is the current time? Use the get_current_time tool.'),
});

/**
 * Buildkite CI eval configuration for triggering and polling eval builds.
 */
export const buildkiteConfigSchema = z.object({
  /** Whether CI evals via Buildkite are enabled. */
  enabled: z.boolean().default(false),
  /** Buildkite API token (read/write builds permission). */
  apiToken: z.string().min(1).optional(),
  /** Buildkite organization slug. */
  orgSlug: z.string().default('elastic'),
  /** Pipeline slug for on-demand eval runs. */
  onDemandPipelineSlug: z.string().default('kibana-evals-on-demand-llm-evals'),
  /** Pipeline slug for weekly eval runs. */
  weeklyPipelineSlug: z.string().default('kibana-evals-weekly-llm-evals'),
  /** Polling interval in milliseconds when waiting for build completion. */
  pollIntervalMs: z.number().int().positive().default(30_000),
  /** Maximum wait time for build completion in milliseconds. */
  pollTimeoutMs: z.number().int().positive().default(10_800_000),
  /** Whether to retry on-demand eval once on failure. */
  retryOnFailure: z.boolean().default(true),
  /**
   * Max times to re-trigger a suite build that Buildkite skipped/canceled before it ran
   * (skip_queued_branch_builds preempting a queued build on the shared branch). These are
   * infra outcomes, not eval failures, so they get their own retry budget separate from
   * retryOnFailure.
   */
  maxSkipRetries: z.number().int().nonnegative().default(5),
  /** Backoff between skip/cancel re-triggers, giving the branch time to fully clear. */
  skipRetryBackoffMs: z.number().int().nonnegative().default(30_000),
  /**
   * Security eval suites to run via weekly Buildkite pipeline (all suites in one matrix build).
   * Subset of weekly security matrix jobs needed for OSS model performance reporting.
   */
  defaultEvalSuites: z
    .array(z.string())
    .default([
      'security-alert-triage',
      'security-alerts-rag-regression',
      'security-esql-generation-regression',
    ]),
  /** Kibana branch to build against. */
  kibanaBranch: z.string().default('fix/weekly-evals-matrix'),
  /** @deprecated Use weekly matrix pipeline (default). Retained for config back-compat. */
  triggerFullEval: z.boolean().default(false),
  /**
   * When true, trigger Buildkite and poll in a background task while Stage 2/3 continue.
   * Tunnel + vLLM deployment stay up until the poll finishes (or times out).
   */
  detachPoll: z.boolean().default(true),
  /**
   * Reuse an in-flight Benchmarker build on the on-demand pipeline when env matches
   * (model, connector, suite) instead of POSTing a duplicate.
   */
  adoptRunningBuild: z.boolean().default(true),
  /**
   * Before creating a new build, wait until no other builds are running on the pipeline.
   * Prevents cross-session collisions (manual kbn-evals runs vs benchmarker daemon).
   */
  waitForPipelineIdle: z.boolean().default(true),
  /** Max wait for pipeline idle before failing build creation. Defaults to pollTimeoutMs. */
  pipelineIdleWaitMs: z.number().int().positive().optional(),
  /** Poll interval while waiting for pipeline idle. */
  pipelineIdlePollMs: z.number().int().positive().default(30_000),
});

/**
 * Pre-deployment baseline for models entering Kibana Agent Builder evals.
 * See elastic/security-team#15545 — parallel tool calling is NOT required.
 */
export const agentBuilderBaselineSchema = z.object({
  /** Apply baseline gate on enqueue, discovery, and CI eval paths. */
  enabled: z.boolean().default(true),
  /** Minimum context window (tokens). Agent Builder security evals need long context. */
  minContextWindow: z.number().int().positive().default(128_000),
  /**
   * Minimum parameter count in billions. Excludes sub-agentic models (e.g. 1.5B).
   * 7B default: pragmatic floor for Agent Builder; override to 4 for broader sweeps.
   */
  minParameterCountBillions: z.number().positive().default(7),
  /**
   * Require single-tool calling support via a known vLLM parser family.
   * Does NOT require parallel/multi-tool calling.
   */
  requireToolCalling: z.boolean().default(true),
  /** Require instruct/chat-tuned checkpoint (instruct/chat/-it in model id). */
  requireInstructVariant: z.boolean().default(true),
});

/**
 * Discovery scheduler configuration for automated model discovery and queueing.
 */
export const discoverySchedulerConfigSchema = z.object({
  /** Whether the discovery scheduler is enabled. */
  enabled: z.boolean().default(false),
  /** Interval in minutes between discovery runs. */
  intervalMinutes: z.number().int().positive().default(60),
  /** Optional search query to filter models by name or tag. */
  search: z.string().optional(),
  /** Maximum number of models to accept per discovery run. */
  maxModelsPerRun: z.number().int().positive().default(10),
  /** Minimum trending score (0–100) required for a model to be considered. */
  minTrendingScore: z.number().min(0).max(100).default(50),
  /** Whether to automatically enqueue discovered models. */
  autoQueue: z.boolean().default(true),
  /** Hardware profile ID used for dry-run fit checks. */
  hardwareProfileId: z.string().default('2xa100-80gb'),
});

/**
 * Application configuration schema
 */
export const appConfigSchema = z.object({
  ssh: sshConfigSchema,
  huggingfaceToken: z.string().min(1, 'HuggingFace token is required'),
  benchmarkThresholds: benchmarkThresholdsSchema.default({}),
  vmHardwareProfile: vmHardwareProfileSchema.default({}),
  /**
   * Optional hardware profile ID that selects a predefined hardware configuration.
   * When set, the corresponding profile's hardware values are used as defaults,
   * but individual vmHardwareProfile fields can still override them.
   */
  hardwareProfileId: z.string().optional(),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  resultsDir: z.string().default('./results'),
  /** Daemon configuration for continuous runner mode. */
  daemon: daemonConfigSchema.default({}),
  /** Tunnel configuration for exposing the vLLM API publicly. */
  tunnel: tunnelConfigSchema.default({}),
  /** Engine configuration for inference engine selection and setup. */
  engine: engineConfigSchema.default({}),
  /** Kibana connector configuration for creating connectors to the vLLM endpoint. */
  kibanaConnector: kibanaConnectorConfigSchema.default({}),
  /** Notification system configuration for benchmark event alerts. */
  notifications: notificationConfigSchema.default({}),
  /** Kibana evaluation runner configuration for testing models via Agent builder features. */
  kibanaEval: kibanaEvalConfigSchema.default({}),
  elasticsearch: elasticsearchConfigSchema.default({}),
  elasticAgent: elasticAgentConfigSchema.default({}),
  /** Stage 2 thresholds for the gate between Stage 1 and Stage 2 benchmarks. */
  stage2Thresholds: stage2ThresholdsSchema.default({}),
  /** Whether to enable the Stage 2 eval pipeline. */
  enableStage2: z.boolean().default(false),
  /** Golden cluster configuration for centralized tracking. */
  goldenCluster: goldenClusterConfigSchema.default({}),
  /** EDOT collector configuration for OpenTelemetry trace collection. */
  edotCollector: edotCollectorConfigSchema.default({}),
  /** Kibana repository configuration for cloning the Kibana main repo. */
  kibanaRepo: kibanaRepoConfigSchema.default({}),
  /** Discovery scheduler configuration for automated model discovery. */
  discoveryScheduler: discoverySchedulerConfigSchema.default({}),
  /** Smoke test configuration for validating deployed models before CI. */
  smokeTest: smokeTestConfigSchema.default({}),
  /** Buildkite CI eval configuration. */
  buildkite: buildkiteConfigSchema.default({}),
  /** Pre-deployment gate for Kibana Agent Builder eval eligibility. */
  agentBuilderBaseline: agentBuilderBaselineSchema.default({}),
  /** LLM configuration for reasoning and evaluation tasks. */
  llmApiKey: z.string().optional().describe('API key for reasoning LLM'),
  llmBaseUrl: z.string().url().optional().describe('Base URL for OpenAI-compatible API'),
  llmModel: z.string().default('gpt-4o').describe('Model name for reasoning'),
  llmMaxTokens: z.number().int().positive().default(4096),
  llmTemperature: z.number().min(0).max(2).default(0.3),
  /** EIS (Elastic Inference Service) configuration — preferred over llmApiKey when set. */
  eisApiKey: z.string().optional().describe('EIS CCM API key for Elastic Inference Service'),
  eisModel: z.string().default('eis/anthropic-claude-4.6-opus').describe('EIS model ID for reasoning'),
});

export type SSHConfig = z.infer<typeof sshConfigSchema>;
export type BenchmarkThresholds = z.infer<typeof benchmarkThresholdsSchema>;
export type ItlTier = z.infer<typeof itlTierSchema>;

/**
 * Resolves a parameter-count-aware ITL (ms) cap from a tier list.
 * Uses the first tier where parameterCountBillions <= maxParamsBillions.
 * Falls back to `flatFallback` when the param count is unknown or non-positive.
 */
function resolveTieredItlCap(
  tiers: ItlTier[],
  flatFallback: number,
  parameterCountBillions: number | null,
): number {
  if (parameterCountBillions === null || parameterCountBillions <= 0) {
    return flatFallback;
  }
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return flatFallback;
  }
  const sorted = [...tiers].sort((a, b) => a.maxParamsBillions - b.maxParamsBillions);
  for (const tier of sorted) {
    if (parameterCountBillions <= tier.maxParamsBillions) {
      return tier.maxITLMs;
    }
  }
  return sorted[sorted.length - 1]?.maxITLMs ?? flatFallback;
}

/**
 * Resolves the Stage 1 max ITL (ms) pass threshold for a model based on its
 * parameter count. Falls back to the flat maxITLMs when param count is null.
 */
export function resolveMaxITLMs(
  thresholds: BenchmarkThresholds,
  parameterCountBillions: number | null,
): number {
  return resolveTieredItlCap(
    thresholds.maxITLMsTiers,
    thresholds.maxITLMs,
    parameterCountBillions,
  );
}

/**
 * Resolves the Stage 2 (CI-eval eligibility) max ITL p50 (ms) cap for a model
 * based on its parameter count. Falls back to the flat maxItlP50Ms when null.
 */
export function resolveMaxItlP50Ms(
  thresholds: Stage2Thresholds,
  parameterCountBillions: number | null,
): number {
  return resolveTieredItlCap(
    thresholds.maxItlP50MsTiers,
    thresholds.maxItlP50Ms,
    parameterCountBillions,
  );
}

export type VMHardwareProfile = z.infer<typeof vmHardwareProfileSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;
export type ScheduleWindow = z.infer<typeof scheduleWindowSchema>;
export type TunnelConfig = z.infer<typeof tunnelConfigSchema>;
export type TunnelProvider = z.infer<typeof tunnelProviderSchema>;
export type EngineConfig = z.infer<typeof engineConfigSchema>;
export type EngineTypeConfig = z.infer<typeof engineTypeSchema>;
export type KibanaConnectorConfig = z.infer<typeof kibanaConnectorConfigSchema>;
export type KibanaEvalConfig = z.infer<typeof kibanaEvalConfigSchema>;
export type NotificationConfig = z.infer<typeof notificationConfigSchema>;
export type ConsoleChannelConfig = z.infer<typeof consoleChannelConfigSchema>;
export type FileChannelConfig = z.infer<typeof fileChannelConfigSchema>;
export type WebhookChannelConfig = z.infer<typeof webhookChannelConfigSchema>;
export type EmailChannelConfig = z.infer<typeof emailChannelConfigSchema>;
export type ElasticsearchConfig = z.infer<typeof elasticsearchConfigSchema>;
export type ElasticAgentConfig = z.infer<typeof elasticAgentConfigSchema>;
export type Stage2Thresholds = z.infer<typeof stage2ThresholdsSchema>;
export type GoldenClusterConfig = z.infer<typeof goldenClusterConfigSchema>;
export type EdotCollectorConfig = z.infer<typeof edotCollectorConfigSchema>;
export type KibanaRepoConfig = z.infer<typeof kibanaRepoConfigSchema>;
export type DiscoverySchedulerConfig = z.infer<typeof discoverySchedulerConfigSchema>;
export type SmokeTestConfig = z.infer<typeof smokeTestConfigSchema>;
export type BuildkiteConfig = z.infer<typeof buildkiteConfigSchema>;
export type AgentBuilderBaselineConfig = z.infer<typeof agentBuilderBaselineSchema>;
