import { Command } from 'commander';
import { gracefulShutdown, CliError } from './shutdown.js';
import { Client } from '@elastic/elasticsearch';
import { resolve, dirname } from 'node:path';
import { mkdirSync, openSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { loadConfig } from '../config/index.js';
import { createElasticsearchClient } from '../utils/es-client.js';
import { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import { ensureIndices } from '../services/es-index-mappings.js';
import { QueueService } from '../services/queue-service.js';
import { Scheduler } from '../scheduler/scheduler.js';
import {
  Stage1WorkerImpl,
  Stage2WorkerImpl,
  Stage2Gate,
  Stage3WorkerImpl,
} from '../worker/index.js';
import { createBatchStage2Worker } from '../worker/batch-stage2-worker.js';
import { KibanaRepoService } from '../services/kibana-repo-service.js';
import { LocalBatchEvalRunner } from '../services/local-batch-eval-runner.js';
import { EvalSuiteRunner } from '../services/eval-suite-runner.js';
import { resolveEvalTierFromConfig, shouldUseLocalStage2 } from '../services/eval-tier-selector.js';
import { Lockfile } from '../utils/lockfile.js';
import { GpuVmLeaseService } from '../services/gpu-vm-lease.js';
import { SSHClientPool } from '../services/ssh-client.js';
import { VllmEngine } from '../engines/vllm-engine.js';
import { createLogger } from '../utils/logger.js';
import type { AppConfig } from '../types/config.js';
import type { LlmClient } from '../services/llm-client.js';
import { LlmClientImpl } from '../services/llm-client.js';
import { EisLlmClient } from '../services/eis-llm-client.js';
import { TraceQueryBuilderImpl } from '../services/trace-query-builder.js';
import { LocalTraceQueryBuilder } from '../services/local-trace-query-builder.js';
import { CompositeTraceQueryBuilder } from '../services/composite-trace-query-builder.js';
import { ReasoningPromptBuilderImpl } from '../services/reasoning-prompt-builder.js';
import { SlackNotifier } from '../services/slack-notifier.js';
import { LocalConnector } from '../services/local-connector.js';
import { DiscoveryScheduler } from '../services/discovery-scheduler.js';
import { MaintenanceScheduler } from '../services/maintenance-scheduler.js';
import { BuildkiteEvalTriggerImpl } from '../services/buildkite-eval-trigger.js';
import { recoverOrFailActiveEntries } from '../services/ci-eval-resume.js';
import { ModelDiscoveryService } from '../services/model-discovery.js';
import { HardwareEstimator } from '../services/hardware-estimator.js';
import { HardwareProfileRegistry } from '../services/hardware-profiles.js';
import type { HardwareProfileDefinition } from '../services/hardware-profiles.js';
import { ModelSmokeTestImpl } from '../services/model-smoke-test.js';
import { createAgentBuilderFilter } from '../services/agent-builder-baseline.js';
import type { CIEvalsOptions } from '../scheduler/scheduler.js';
import { runEnqueue } from './enqueue-handler.js';

// ─── ES Client Helper ───────────────────────────────────────────────────────────
export function createEsClient(config: AppConfig | null): Client | null {
  if (!config) return null;
  return createElasticsearchClient(config.elasticsearch);
}

/**
 * Resolve the single hardware profile that both ModelDiscoveryService's
 * Step 5 hardware-fit gate and DiscoveryScheduler.scoreModels()'s own
 * hardware-fit re-check should agree on.
 *
 * Step 5 (inside ModelDiscoveryService.evaluateCandidate()) is
 * *authoritative* — a rejection there excludes the candidate from
 * discover()'s result.models entirely, so scoreModels() never even sees it.
 * Previously these two gates were fed from independently-configured sources
 * (config.vmHardwareProfile vs discoveryScheduler.hardwareProfileId resolved
 * through the registry) that only agreed on i9 because both config values
 * happened to be manually kept in sync — nothing enforced it, so they could
 * silently drift and wrongly reject a model against the wrong profile.
 * Exported as a pure function so the resolution is unit-testable without
 * spinning up the full discovery scheduler wiring.
 */
export function resolveDiscoveryHardwareProfile(
  hardwareProfileId: string,
  profileRegistry: HardwareProfileRegistry,
): HardwareProfileDefinition | undefined {
  return profileRegistry.getProfile(hardwareProfileId);
}

/**
 * The single hard gate for enabling the Buildkite CI-eval pipeline.
 *
 * `config.buildkite.enabled: false` is a standing operator kill-switch and
 * must be an unconditional AND, never an alternate OR path. Before this fix,
 * `(enableCIEvals || config.buildkite.enabled) && Boolean(apiToken)` meant the
 * `--ci-evals` CLI flag alone could enable Buildkite even with
 * `buildkite.enabled: false` in config, as long as an API token happened to
 * be resolvable (env var, or the `~/.buildkite/token` file `start-local.sh`
 * reads for unrelated tooling). That silently violated the standing policy
 * and fired real on-demand Buildkite builds (~$8/build) against models that
 * had already passed the local Stage 2 batch eval — see builds #316-326 on
 * 2026-07-28, which mislabeled QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ and
 * cyankiwi/Qwen3-Coder-30B-A3B-Instruct-AWQ-4bit as `failed`.
 *
 * Both call sites in this file must use this helper rather than re-deriving
 * the condition inline.
 */
export function shouldEnableCIEvals(
  enableCIEvals: boolean,
  buildkiteEnabled: boolean,
  buildkiteApiToken: string | undefined,
): boolean {
  return enableCIEvals && buildkiteEnabled && Boolean(buildkiteApiToken);
}

function resolveStartConfigPath(fallback: string): string {
  if (process.env['BENCHMARKER_CONFIG']) {
    return process.env['BENCHMARKER_CONFIG'];
  }
  const args = process.argv.slice(2);
  const startIdx = args.indexOf('start');
  const searchFrom = startIdx >= 0 ? startIdx + 1 : 0;
  for (let i = searchFrom; i < args.length; i++) {
    if ((args[i] === '--config' || args[i] === '-c') && args[i + 1] !== undefined) {
      return args[i + 1]!;
    }
  }
  return fallback;
}

function loadAppConfig(options: { config?: string; json?: boolean }): AppConfig | null {
  try {
    const configPath = options.config ? resolve(process.cwd(), options.config) : undefined;
    return loadConfig(undefined, {
      configPath,
    });
  } catch (err) {
    if (!options.json) {
      console.error(
        `Error loading configuration: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }
}

export function createLlmClient(
  config: AppConfig,
  esClient: Client,
  logger: ReturnType<typeof createLogger>,
): LlmClient | undefined {
  const es = config.elasticsearch;
  const esAuthHeader = es.apiKey
    ? `ApiKey ${es.apiKey}`
    : es.username && es.password
      ? `Basic ${Buffer.from(`${es.username}:${es.password}`).toString('base64')}`
      : undefined;

  // Use EIS when a CCM key is explicitly set (self-managed activation), or when
  // the ES cluster is API-key authed (serverless/cloud provisions EIS natively,
  // so no CCM key is needed). An explicit llmApiKey still wins over the
  // serverless-native fallback.
  const useEis = Boolean(config.eisApiKey) || (Boolean(es.apiKey) && !config.llmApiKey);
  if (useEis) {
    logger.info('Stage 3 reasoning: using EIS (Elastic Inference Service)', {
      model: config.eisModel,
      ccm: config.eisApiKey ? 'key-provided' : 'native',
    });
    return new EisLlmClient(
      esClient,
      config.eisApiKey,
      config.eisModel,
      es.url ?? 'http://localhost:9223',
      esAuthHeader,
      logger,
    );
  }
  if (config.llmApiKey) {
    logger.info('Stage 3 reasoning: using OpenAI-compatible LLM', { model: config.llmModel });
    return new LlmClientImpl(config, logger);
  }
  logger.warn('Stage 3 reasoning: no LLM configured (set EIS_CCM_API_KEY or LLM_API_KEY)');
  return undefined;
}

// ─── Start Handler ─────────────────────────────────────────────────────────────

export async function startHandler(
  opts: Record<string, unknown>,
  _deps: { program: Command },
): Promise<void> {
  const configPath = resolveStartConfigPath(opts['config'] as string);
  const pollInterval = parseInt(opts['pollInterval'] as string, 10);
  const enableStage2 = opts['stage2'] as boolean;
  const enableStage3 = opts['stage3'] as boolean;
  const enableDiscovery = opts['discovery'] as boolean;
  const enableCIEvals = opts['ciEvals'] as boolean;
  const daemonize = opts['daemonize'] as boolean;
  const clearPending = opts['clearPending'] as boolean;
  const enqueueAfterClear = opts['enqueueAfterClear'] as string | undefined;
  const queueModel = opts['queueModel'] as string | undefined;
  const connectorType = opts['connector'] as string;
  const outputDir = opts['outputDir'] as string;
  const useLocalConnector = connectorType === 'local';

  // Load config first — needed for both one-off enqueue and scheduler start
  const config = loadAppConfig({ config: configPath, json: false });
  if (!config) throw new CliError('Failed to load configuration', 1);

  if (daemonize && !queueModel) {
    const absConfigPath = resolve(process.cwd(), configPath);
    const childArgs = process.argv.slice(2).filter((arg) => arg !== '--daemonize');
    for (let i = 0; i < childArgs.length; i++) {
      if (childArgs[i] === '--config' || childArgs[i] === '-c') {
        childArgs[i + 1] = absConfigPath;
      }
    }
    if (!childArgs.includes(absConfigPath)) {
      const startIdx = childArgs.indexOf('start');
      const insertAt = startIdx >= 0 ? startIdx + 1 : 0;
      childArgs.splice(insertAt, 0, '--config', absConfigPath);
    }
    const cliEntry = process.argv[1] ?? resolve(process.cwd(), 'dist/cli.js');
    const logPath = resolve(process.cwd(), '.smoke-logs/daemon.log');
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, 'a');
    const child = spawn(process.execPath, [cliEntry, ...childArgs], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
      cwd: process.cwd(),
    });
    child.unref();
    console.log(`benchmarker-queue daemon started (pid ${child.pid ?? 'unknown'}, log ${logPath})`);
    process.exit(0);
  }

  // Keep the event loop alive when stdin is closed (agent shells, nohup, launchd).
  if (process.stdin.isTTY !== true) {
    process.stdin.resume();
  }

  // One-off enqueue mode (for CI)
  if (queueModel) {
    const esClient = createEsClient(config);
    if (!esClient) {
      console.error('Error: Could not create Elasticsearch client');
      throw new CliError('Could not create Elasticsearch client', 1);
    }

    try {
      const result = await runEnqueue({
        modelId: queueModel,
        config,
        esClient,
        hardwareProfileId: config.hardwareProfileId,
        priority: 5,
      });

      if (!result.success) {
        console.error(`Error: ${result.message}`);
        await esClient.close();
        throw new CliError(result.message, 1);
      }

      console.log(result.message);
      if (result.dryRun) {
        console.log(
          `Dry-run: estimated ${result.dryRun.estimatedGb.toFixed(2)} GB / available ${result.dryRun.availableGb.toFixed(2)} GB (${result.dryRun.fits ? 'fits' : 'does not fit'})`,
        );
      }
      await esClient.close();
      process.exit(0);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      await esClient.close();
      throw new CliError(error instanceof Error ? error.message : String(error), 1);
    }
  }

  // Lockfile check (only when actually starting the scheduler)
  const lockfile = new Lockfile({ path: '.benchmarker-queue.lock' });
  if (!lockfile.acquire()) {
    console.error('Error: benchmarker-queue is already running (lockfile exists)');
    throw new CliError('benchmarker-queue is already running (lockfile exists)', 1);
  }

  // Pre-flight health check — pass config values as env vars
  try {
    const healthEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELASTICSEARCH_URL: config.elasticsearch.url,
      SSH_HOST: config.ssh.host,
      SSH_PORT: String(config.ssh.port),
      SSH_USERNAME: config.ssh.username,
    };
    if (config.ssh.privateKeyPath) {
      healthEnv['SSH_KEY_PATH'] = config.ssh.privateKeyPath;
    }
    execSync('bash scripts/health-check.sh', { stdio: 'inherit', env: healthEnv });
  } catch {
    lockfile.release();
    console.error('Error: Health check failed. Fix issues and try again.');
    throw new CliError('Health check failed. Fix issues and try again.', 1);
  }

  const logger = createLogger(config.logLevel ?? 'info');
  logger.info('Config loaded successfully', {
    configPath: resolve(process.cwd(), configPath),
    buildkiteBranch: config.buildkite.kibanaBranch,
    evalTier: config.evalTier ?? (config.buildkite.enabled ? 'buildkite-weekly' : 'local'),
    stage2LocalEvalSuites: config.stage2Local.evalSuites,
    buildkiteEvalSuites: config.buildkite.defaultEvalSuites,
  });

  // Create ES client
  const esClient = createEsClient(config);
  if (!esClient) {
    lockfile.release();
    console.error('Error: Could not create Elasticsearch client');
    throw new CliError('Could not create Elasticsearch client', 1);
  }

  // Ensure all ES indices exist with correct mappings
  await ensureIndices(esClient);
  logger.info('ES indices verified');

  // Create queue service
  const queueService = new QueueService(esClient);
  logger.info('Queue service ready');

  const resultsStore = new ElasticsearchResultsStore(esClient);

  // Cross-host GPU VM lease — acquire BEFORE any queue cleanup. The local
  // lockfile only guards this host; a daemon on another machine sharing this
  // Elasticsearch cluster + GPU VM would otherwise deploy concurrently and
  // thrash the VM (and the serial Buildkite pipeline). Critically, acquiring
  // first also prevents a second daemon from reclaiming/failing in-flight
  // queue entries that a live daemon is still processing.
  const gpuVmLease = new GpuVmLeaseService({
    esClient,
    vmHost: config.ssh.host,
    logLevel: config.logLevel,
  });
  const leaseResult = await gpuVmLease.acquire();
  if (!leaseResult.success) {
    const held = leaseResult.heldBy;
    const ageMs = leaseResult.heldByAgeMs;
    const staleMs = leaseResult.staleAfterMs;
    logger.error('GPU VM lease held by another benchmarker daemon — refusing to start', {
      vmHost: config.ssh.host,
      heldBy: held
        ? `${held.ownerHostname} (pid ${held.ownerPid}, heartbeat ${held.heartbeatAt})`
        : (leaseResult.error ?? 'unknown'),
      heartbeatAgeSeconds: ageMs != null ? Math.round(ageMs / 1000) : undefined,
      staleAfterSeconds: staleMs != null ? Math.round(staleMs / 1000) : undefined,
      diagnosis:
        ageMs != null && staleMs != null
          ? ageMs < staleMs
            ? 'live daemon holds the lease (single-owner rule: benchmarker runs on kibana-i9 ONLY)'
            : 'stale lease past threshold — safe to reclaim'
          : undefined,
    });
    lockfile.release();
    await resultsStore.close();
    await esClient.close();
    throw new CliError('Fatal error during scheduler startup', 1);
  }
  logger.info('Acquired GPU VM lease', { vmHost: config.ssh.host });

  // config.buildkite.enabled is the hard kill-switch — it must gate Buildkite
  // triggering unconditionally, not just serve as an alternate way to enable it.
  // See shouldEnableCIEvals() docstring for the full incident writeup.
  const ciEvalsEnabled = shouldEnableCIEvals(
    enableCIEvals,
    config.buildkite.enabled,
    config.buildkite.apiToken,
  );

  if (ciEvalsEnabled && config.buildkite.apiToken) {
    const buildkiteTrigger = new BuildkiteEvalTriggerImpl(
      {
        apiToken: config.buildkite.apiToken,
        orgSlug: config.buildkite.orgSlug,
        onDemandPipelineSlug: config.buildkite.onDemandPipelineSlug,
        weeklyPipelineSlug: config.buildkite.weeklyPipelineSlug,
        pollIntervalMs: config.buildkite.pollIntervalMs,
        pollTimeoutMs: config.buildkite.pollTimeoutMs,
        retryOnFailure: config.buildkite.retryOnFailure,
        defaultEvalSuites: config.buildkite.defaultEvalSuites,
        kibanaBranch: config.buildkite.kibanaBranch,
        detachPoll: config.buildkite.detachPoll,
        adoptRunningBuild: config.buildkite.adoptRunningBuild,
        waitForPipelineIdle: config.buildkite.waitForPipelineIdle,
        pipelineIdleWaitMs: config.buildkite.pipelineIdleWaitMs,
        pipelineIdlePollMs: config.buildkite.pipelineIdlePollMs,
      },
      config.logLevel,
    );
    const { recovered, reclaimed } = await recoverOrFailActiveEntries(
      queueService,
      resultsStore,
      buildkiteTrigger,
      config.buildkite.defaultEvalSuites ?? [],
      logger,
    );
    if (recovered > 0) {
      logger.info('Recovered in-flight CI eval queue entries after daemon restart', {
        recovered,
      });
    }
    if (reclaimed > 0) {
      logger.warn('Reclaimed orphaned active queue entries to pending for retry', {
        count: reclaimed,
      });
    }
  } else {
    // VM lease already acquired above, so any in-flight entry is genuinely
    // orphaned by a dead daemon. Reclaim stale ones to `pending` for retry
    // instead of failing them (a crash shouldn't lose a queued model).
    const reclaimed = await queueService.reclaimStaleEntries(config.scheduler.entryStaleAfterMs);
    if (reclaimed > 0) {
      logger.warn('Reclaimed stale in-flight queue entries to pending before starting scheduler', {
        count: reclaimed,
      });
    }
  }

  if (clearPending) {
    const cancelled = await queueService.cancelAllPending();
    if (cancelled > 0) {
      logger.info('Cancelled pending queue entries before starting scheduler', {
        count: cancelled,
      });
    }
  }

  if (enqueueAfterClear) {
    const enqueueResult = await runEnqueue({
      modelId: enqueueAfterClear,
      config,
      esClient,
      hardwareProfileId: config.hardwareProfileId,
      priority: 999,
      force: true,
    });
    if (!enqueueResult.success) {
      lockfile.release();
      logger.error('Failed to enqueue validation model after clear-pending', {
        modelId: enqueueAfterClear,
        error: enqueueResult.message,
      });
      throw new CliError(enqueueResult.message, 1);
    }
    logger.info('Enqueued validation model after clear-pending', {
      modelId: enqueueAfterClear,
      queueEntryId: enqueueResult.entryId,
    });
  }

  // Create worker dependencies
  const sshPool = new SSHClientPool({}, config.logLevel ?? 'info');
  const vllmEngine = new VllmEngine(sshPool, config.logLevel ?? 'info', {
    deployment: {
      dockerImage: config.engine?.dockerImage,
      gpuMemoryUtilization: config.engine?.vllmGpuMemoryUtilization,
      maxModelLen: config.engine?.maxModelLen,
      huggingfaceToken: config.huggingfaceToken,
      useSudo: config.ssh.useSudo,
      healthCheckTimeoutMs: config.benchmarkThresholds.healthCheckTimeoutSeconds * 1000,
      healthCheckTimeoutSecondsTiers: config.benchmarkThresholds.healthCheckTimeoutSecondsTiers,
      minFreeDiskGb: config.engine?.minFreeDiskGb,
      modelLoadHeadroomGb: config.engine?.modelLoadHeadroomGb,
      // Emit vLLM OTLP traces to the EDOT collector when configured. vLLM runs
      // in a bridge-network container on the remote VM, so the endpoint is
      // resolved from the container's perspective (host.docker.internal) and
      // reaches the local collector via a reverse SSH tunnel.
      otlpTracesEndpoint: config.edotCollector.vllmOtlpTracesEndpoint,
    },
  });

  // ciEvalsEnabled computed above for startup recovery

  // Resolve the eval tier: local-only (Tier-1 in-VPC), Buildkite weekly
  // (Tier-2), or local-then-weekly (Tier-1 gates Tier-2). When
  // evalTier === 'local', the local stage2-worker runs even if CI evals
  // are configured — this is the GCP autonomous default.
  const evalTier = resolveEvalTierFromConfig(
    config,
    ciEvalsEnabled && (enableStage2 || config.enableStage2),
  );
  const useLocalStage2 = shouldUseLocalStage2(evalTier);

  // Optionally create Stage 2 worker (local Kibana clone path).
  // Instantiated when the resolved tier calls for local evals, regardless
  // of whether Buildkite CI evals are also wired.
  //
  // When stage2Local.useBatchRunner is enabled, delegate to the skill-dev
  // plugin's run-security-evals-batch.sh instead of the single-suite
  // eval-suite-runner. The batch runner boots parallel Scout stacks with
  // the merged evals_security_all config and two-stage EIS connector boot.
  // useBatchRunner defaults to true, but skillDevPluginDir has no default
  // (it's an environment-specific checkout path) — without it,
  // LocalBatchEvalRunner.run() throws on the very first Stage 2
  // invocation. Fall back to the single-stack worker instead of failing
  // every run when the plugin isn't configured.
  const canUseBatchRunner =
    config.stage2Local.useBatchRunner && Boolean(config.stage2Local.skillDevPluginDir);
  if (config.stage2Local.useBatchRunner && !config.stage2Local.skillDevPluginDir) {
    logger.warn(
      'stage2Local.useBatchRunner is true but stage2Local.skillDevPluginDir is not set — falling back to the single-stack eval-suite-runner path',
    );
  }

  const stage2Worker =
    (enableStage2 || config.enableStage2) && useLocalStage2
      ? canUseBatchRunner
        ? (() => {
            const batchRunner = new LocalBatchEvalRunner(config.stage2Local, logger);
            return createBatchStage2Worker({
              config,
              gate: new Stage2Gate(config),
              batchRunner,
              resultsStore,
              queueService,
              logger,
            });
          })()
        : new Stage2WorkerImpl({
            config,
            gate: new Stage2Gate(config),
            repoService: new KibanaRepoService({ config, logger }),
            evalRunner: new EvalSuiteRunner({ esStore: resultsStore, logger }),
            resultsStore,
            logger,
          })
      : undefined;

  if (stage2Worker) {
    logger.info('Stage 2 local eval pipeline enabled', { evalTier });
  } else if (evalTier === 'buildkiteWeekly') {
    logger.info('Stage 2 uses Buildkite Kibana CI evals only (local eval-suite-runner disabled)', {
      evalTier,
    });
  } else if ((enableStage2 || config.enableStage2) && evalTier === 'none') {
    logger.info('Stage 2 disabled (no eval tier resolved)', { evalTier });
  }

  // Optionally create Stage 3 worker
  let stage3Worker: Stage3WorkerImpl | undefined;
  if (enableStage3) {
    const llmClient = createLlmClient(config, esClient, logger);
    if (llmClient) {
      stage3Worker = new Stage3WorkerImpl({
        config,
        traceQueryBuilder: new CompositeTraceQueryBuilder(
          new TraceQueryBuilderImpl(esClient, logger, config.edotCollector.traceIndexPattern),
          new LocalTraceQueryBuilder(),
        ),
        promptBuilder: new ReasoningPromptBuilderImpl(),
        llmClient,
        resultsStore,
        logger,
      });
      logger.info('Stage 3 reasoning pipeline enabled');
    }
  }

  // Optionally create Slack notifier
  const slackWebhookUrl = config.notifications.webhook.url;
  const slackNotifier =
    slackWebhookUrl && config.notifications.webhook.enabled
      ? new SlackNotifier({ webhookUrl: slackWebhookUrl, logLevel: config.logLevel })
      : undefined;

  if (slackNotifier) {
    logger.info('Slack notifications enabled');
  }

  // Local connector mode
  if (useLocalConnector) {
    const localConnector = new LocalConnector({ outputDir, logLevel: config.logLevel });
    const initResult = await localConnector.initialize();
    if (!initResult.success) {
      logger.error('Failed to initialize local connector', { error: initResult.error });
      lockfile.release();
      throw new CliError(initResult.error ?? 'Failed to initialize local connector', 1);
    }
    logger.info('Local connector initialized', { outputDir });
  }

  // Start HuggingFace model discovery scheduler (auto-discovers and queues models)
  let discoveryScheduler: DiscoveryScheduler | undefined;
  if (enableDiscovery || config.discoveryScheduler.enabled) {
    const profileRegistry = new HardwareProfileRegistry();
    const existingResults = await resultsStore.query({ limit: 10000 });
    const evaluatedIds = [...new Set(existingResults.map((r) => r.modelId))];

    // Both ModelDiscoveryService.evaluateCandidate() (Step 5 hardware-fit
    // gate, which is *authoritative* — a rejection here excludes the
    // candidate from discover()'s result.models entirely) and
    // DiscoveryScheduler.scoreModels() (its own hardware-fit re-check)
    // need to agree on the same hardware target — see
    // resolveDiscoveryHardwareProfile()'s doc comment for why.
    const discoveryHardwareProfile = resolveDiscoveryHardwareProfile(
      config.discoveryScheduler.hardwareProfileId,
      profileRegistry,
    );
    if (!discoveryHardwareProfile) {
      logger.warn(
        `Discovery hardware profile not found: ${config.discoveryScheduler.hardwareProfileId} — Step 5 hardware-fit check will be skipped`,
      );
    }

    const discoveryService = new ModelDiscoveryService(
      config.huggingfaceToken,
      evaluatedIds,
      config.logLevel,
      discoveryHardwareProfile?.hardware,
    );

    discoveryScheduler = new DiscoveryScheduler({
      discoveryService,
      hardwareEstimator: new HardwareEstimator(),
      profileRegistry,
      queueService,
      config: config.discoveryScheduler,
      candidateFilter: config.agentBuilderBaseline.enabled
        ? createAgentBuilderFilter(config)
        : undefined,
      logger,
    });
    discoveryScheduler.start();
    logger.info(
      `HuggingFace discovery scheduler started (interval: ${config.discoveryScheduler.intervalMinutes} min)`,
    );
  } else {
    logger.info(
      'HuggingFace discovery scheduler disabled (set discoveryScheduler.enabled=true to enable)',
    );
  }

  // Optionally create CI evals pipeline
  // Same hard-gate rule as ciEvalsEnabled above — see shouldEnableCIEvals().
  let ciEvalsOptions: CIEvalsOptions | undefined;
  if (
    shouldEnableCIEvals(enableCIEvals, config.buildkite.enabled, config.buildkite.apiToken) &&
    config.buildkite.apiToken
  ) {
    const smokeTest = new ModelSmokeTestImpl(config.smokeTest, config.logLevel);
    const buildkiteTrigger = new BuildkiteEvalTriggerImpl(
      {
        apiToken: config.buildkite.apiToken,
        orgSlug: config.buildkite.orgSlug,
        onDemandPipelineSlug: config.buildkite.onDemandPipelineSlug,
        weeklyPipelineSlug: config.buildkite.weeklyPipelineSlug,
        pollIntervalMs: config.buildkite.pollIntervalMs,
        pollTimeoutMs: config.buildkite.pollTimeoutMs,
        retryOnFailure: config.buildkite.retryOnFailure,
        defaultEvalSuites: config.buildkite.defaultEvalSuites,
        kibanaBranch: config.buildkite.kibanaBranch,
        detachPoll: config.buildkite.detachPoll,
        adoptRunningBuild: config.buildkite.adoptRunningBuild,
        waitForPipelineIdle: config.buildkite.waitForPipelineIdle,
        pipelineIdleWaitMs: config.buildkite.pipelineIdleWaitMs,
        pipelineIdlePollMs: config.buildkite.pipelineIdlePollMs,
      },
      config.logLevel,
    );
    ciEvalsOptions = {
      enabled: true,
      detachPoll: config.buildkite.detachPoll,
      smokeTest,
      buildkiteTrigger,
      sshPool,
    };
    logger.info('CI eval pipeline enabled (on-demand security matrix suites only)');
    logger.info('Buildkite eval config', {
      kibanaBranch: config.buildkite.kibanaBranch,
      defaultEvalSuites: config.buildkite.defaultEvalSuites,
      kibanaRepoBranch: config.kibanaRepo.branch,
    });
  } else if (enableCIEvals) {
    logger.warn('CI evals requested but buildkite.apiToken is missing — skipping');
  }

  // Create scheduler
  const scheduler = new Scheduler(
    queueService,
    new Stage1WorkerImpl({
      config,
      queueService,
      resultsStore,
      vllmEngine,
      logger,
    }),
    { pollIntervalMs: pollInterval, maxConcurrentRuns: 1 },
    stage2Worker,
    resultsStore,
    stage3Worker,
    config,
    slackNotifier,
    vllmEngine,
    ciEvalsOptions,
  );

  // GPU VM lease acquired earlier (before queue cleanup). Keep it fresh
  // with a periodic heartbeat so other daemons see it as live.
  const leaseHeartbeat = setInterval(() => {
    void gpuVmLease.heartbeat();
  }, 30_000);
  // Do not keep the event loop alive on heartbeat alone.
  leaseHeartbeat.unref();

  logger.info(`Scheduler starting. Polling every ${pollInterval} ms...`);
  scheduler.start();

  // Periodic maintenance & health tick: VM cost/utilization emission, DLQ
  // re-try sweep, and Slack health digest. Never stops the VM.
  let maintenanceScheduler: MaintenanceScheduler | undefined;
  if (config.maintenance.enabled) {
    maintenanceScheduler = new MaintenanceScheduler({
      esClient,
      queueService,
      resultsStore,
      config: config.maintenance,
      costCaps: config.costCaps,
      vmHost: config.ssh.host,
      hardwareProfileId: config.discoveryScheduler.hardwareProfileId,
      slackNotifier,
      logger,
    });
    maintenanceScheduler.start();
    logger.info(`Maintenance scheduler started (interval: ${config.maintenance.intervalHours}h)`);
  }

  // Graceful shutdown — ignore SIGHUP so agent/shell disconnect does not kill mid-Buildkite poll.
  process.on('SIGHUP', () => {
    logger.warn('Received SIGHUP — ignoring (daemon keeps running)');
  });

  // Graceful shutdown — delegate to centralized shutdown utility
  const shutdown = async (signal: string) => {
    await gracefulShutdown(
      {
        scheduler,
        sshPool,
        esClient,
        resultsStore,
        gpuVmLease,
        lockfile,
        leaseHeartbeat,
        discoveryScheduler,
        maintenanceScheduler,
      },
      signal,
      logger,
    );
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
