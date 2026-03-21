import type { RunnableConfig } from '@langchain/core/runnables';
import type { GraphState, GraphStateUpdate } from './state.js';
import type { BenchmarkConfigurable } from './configurable.js';
import type { CheckpointEvent } from '../services/elasticsearch-results-store.js';
import type { ModelInfo, BenchmarkResult, ToolCallResult } from '../types/benchmark.js';
import type { VMHardwareProfile } from '../types/config.js';
import type { EngineDeploymentResult, EngineFullBenchmarkResult } from '../engines/engine-types.js';
import type { ErrorCategory } from '../services/error-recovery.js';
import { SSHConnectionError, SSHTimeoutError } from '../services/ssh-client.js';
import { ContainerError, HealthCheckError } from '../services/vllm-deployment.js';
import { HealthCheckServiceError } from '../services/health-check.js';
import { getModelParamsBillions } from '../services/gpu-requirements.js';
import { ToolCallBenchmarkService } from '../services/tool-call-benchmark.js';
import { CapabilityDetectionService } from '../services/capability-detection.js';
import { ConfigResearcherService } from '../services/config-researcher.js';
import { createLogger } from '../utils/logger.js';
import { MAX_MODELS_TO_EVALUATE, TOP_MODELS_TO_QUEUE, SCORING_WEIGHTS, DISCOVERY_CONCURRENCY } from './discovery-constants.js';
import pLimit from 'p-limit';

const logger = createLogger('info');

/**
 * Maximum consecutive errors before the agent transitions to a terminal error state.
 */
const MAX_ERROR_COUNT = 5;

function getConfigurable(config: RunnableConfig): BenchmarkConfigurable {
  return (config.configurable ?? {}) as BenchmarkConfigurable;
}

// ─── Node Functions ─────────────────────────────────────────────────────────

/**
 * IDLE node: Entry point of the agent loop.
 * Transitions the agent to begin discovering models.
 */
export async function idleNode(
  _state: GraphState,
  _config: RunnableConfig,
): Promise<GraphStateUpdate> {
  logger.info('Agent is idle, preparing to discover models');

  return {
    currentState: 'discovering_models',
    error: null,
  };
}

/**
 * DISCOVER MODELS node: Scans for new models that match our criteria.
 *
 * In production, this would call the HuggingFace API to find models.
 * Optionally merges pending user-submitted queue entries at the front
 * and persists discovered models to the results store.
 */
export async function discoverModelsNode(
  state: GraphState,
  config: RunnableConfig,
): Promise<GraphStateUpdate> {
  const cfg = getConfigurable(config);
  const { queueService, resultsStore } = cfg;

  logger.info('Discovering models from HuggingFace', {
    previouslyEvaluated: state.evaluatedModelIds.length,
  });

  let discoveredModels = state.discoveredModels;

  // If a model was pre-seeded via CLI (--model flag), ensure it appears in
  // discoveredModels so evaluateModelNode can pick it up.
  if (state.currentModel && discoveredModels.length === 0) {
    logger.info(`Using pre-seeded model for discovery: ${state.currentModel.id}`);
    discoveredModels = [state.currentModel];
  } else {
    // Placeholder: actual HuggingFace discovery will be implemented
    // by a separate feature. For now, preserve pre-seeded models that haven't
    // been evaluated yet (filters out already-evaluated ones to avoid re-running).
    discoveredModels = discoveredModels.filter(
      (m: ModelInfo) => !state.evaluatedModelIds.includes(m.id),
    );

    // Merge pending user-submitted queue entries at the front
    if (queueService) {
      const pendingEntries = await queueService.getQueue({
        status: 'pending',
        source: 'user',
      });
      if (pendingEntries.length > 0) {
        const queueModels: ModelInfo[] = pendingEntries.map((e) => ({
          id: e.modelId,
          name: e.modelId.split('/').pop() ?? e.modelId,
          architecture: 'unknown',
          contextWindow: 0,
          license: '',
          parameterCount: null,
          quantizations: [],
          supportsToolCalling: false,
        }));
        discoveredModels = [...queueModels, ...discoveredModels];
      }
    }

    const store = resultsStore;
    if (store && typeof store.saveModel === 'function') {
      for (const model of discoveredModels) {
        try {
          await store.saveModel({
            modelId: model.id,
            name: model.name,
            architecture: model.architecture,
            parameterCount: model.parameterCount,
            contextWindow: model.contextWindow,
            license: model.license,
            supportsToolCalling: model.supportsToolCalling,
            quantizations: model.quantizations,
            source: 'hf_discovery',
          });
        } catch (err) {
          logger.warn(`Failed to save model ${model.id} to catalog`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return {
    currentState: 'evaluating_model',
    discoveredModels,
    lastSuccessTimestamp: Date.now(),
    error: null,
    errorCount: 0,
  };
}

/**
 * EVALUATE MODEL node: Selects the next unevaluated model from discovered models
 * or from the queue via dequeue.
 *
 * If queueService exists, tries dequeue first. If dequeue returns a model,
 * uses it (status is already 'deploying' from dequeue). Otherwise picks
 * from discoveredModels.
 */
export async function evaluateModelNode(
  state: GraphState,
  config: RunnableConfig,
): Promise<GraphStateUpdate> {
  const cfg = getConfigurable(config);
  const { queueService } = cfg;
  const skippedIds = state.skippedModelIds ?? [];

  // Try dequeue first if queue service exists
  if (queueService) {
    const entry = await queueService.dequeue();
    if (entry) {
      const nextModel: ModelInfo = {
        id: entry.modelId,
        name: entry.modelId.split('/').pop() ?? entry.modelId,
        architecture: 'unknown',
        contextWindow: 0,
        license: '',
        parameterCount: null,
        quantizations: [],
        supportsToolCalling: false,
      };
      const isSameModel = state.currentModel?.id === nextModel.id;
      logger.info(`Dequeued model for evaluation: ${nextModel.id}`, {
        entryId: entry.id,
        isRetry: isSameModel,
      });
      return {
        currentState: 'running_benchmark',
        currentModel: nextModel,
        lastSuccessTimestamp: Date.now(),
        error: null,
        errorCount: 0,
        ...(isSameModel ? {} : { currentModelRetryCount: 0 }),
      };
    }
  }

  // Fall back to discovered models
  const unevaluated = state.discoveredModels.filter(
    (m: ModelInfo) =>
      !state.evaluatedModelIds.includes(m.id) && !skippedIds.includes(m.id),
  );

  if (unevaluated.length === 0) {
    const totalSkipped = skippedIds.length;
    logger.info('All discovered models have been evaluated or skipped', {
      evaluated: state.evaluatedModelIds.length,
      skipped: totalSkipped,
    });
    return {
      currentState: 'idle',
      currentModel: null,
      lastSuccessTimestamp: Date.now(),
      currentModelRetryCount: 0,
    };
  }

  const nextModel = unevaluated[0]!;
  const isSameModel = state.currentModel?.id === nextModel.id;
  logger.info(`Selected model for evaluation: ${nextModel.id}`, {
    remaining: unevaluated.length - 1,
    skipped: skippedIds.length,
    isRetry: isSameModel,
    retryCount: isSameModel ? state.currentModelRetryCount : 0,
  });

  return {
    currentState: 'running_benchmark',
    currentModel: nextModel,
    lastSuccessTimestamp: Date.now(),
    error: null,
    errorCount: 0,
    ...(isSameModel ? {} : { currentModelRetryCount: 0 }),
  };
}

/**
 * Classifies an error into an ErrorCategory for the error handler routing.
 */
function classifyError(error: unknown): ErrorCategory {
  if (error instanceof SSHConnectionError) return 'ssh_connection';
  if (error instanceof SSHTimeoutError) return 'ssh_timeout';
  if (error instanceof HealthCheckError || error instanceof HealthCheckServiceError) {
    const msg = error.message.toLowerCase();
    if (msg.includes('oom') || msg.includes('out of memory') || msg.includes('cuda'))
      return 'oom';
    if (msg.includes('gated') || msg.includes('license')) return 'fatal_model_error';
    return 'docker_crash';
  }
  if (error instanceof ContainerError) return 'docker_crash';
  const msg =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (msg.includes('oom') || msg.includes('out of memory') || msg.includes('cuda'))
    return 'oom';
  if (msg.includes('gated') || msg.includes('license') || msg.includes('access'))
    return 'fatal_model_error';
  if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('ssh'))
    return 'ssh_connection';
  if (msg.includes('timeout')) return 'ssh_timeout';
  return 'unknown';
}

/**
 * Converts engine-level deployment + benchmark results into the
 * canonical BenchmarkResult that the ResultsStore and dashboard consume.
 */
function buildBenchmarkResult(
  model: ModelInfo,
  deployment: EngineDeploymentResult,
  engineResult: EngineFullBenchmarkResult,
  hardwareProfile: VMHardwareProfile,
  toolCallResults: ToolCallResult | null = null,
  reasoningResults: import('../types/reasoning.js').ReasoningBenchmarkResult | null = null,
): BenchmarkResult {
  return {
    modelId: model.id,
    timestamp: deployment.timestamp,
    vllmVersion: deployment.engineImage,
    dockerCommand: deployment.deploymentCommand,
    hardwareConfig: {
      gpuType: hardwareProfile.gpuType,
      gpuCount: hardwareProfile.gpuCount,
      ramGb: hardwareProfile.ramGb,
      cpuCores: hardwareProfile.cpuCores,
      diskGb: hardwareProfile.diskGb,
      machineType: hardwareProfile.machineType,
      hardwareProfileId: null,
    },
    benchmarkMetrics: engineResult.runs
      .filter((r) => r.success)
      .map((r) => r.metrics),
    toolCallResults,
    reasoningResults,
    passed: engineResult.passed,
    rejectionReasons: engineResult.rejectionReasons,
    tensorParallelSize: deployment.parallelismConfig,
    toolCallParser: deployment.toolCallParser,
    rawOutput: engineResult.combinedRawOutput,
    gpuUtilization: deployment.gpuUtilization ?? null,
  };
}

/**
 * RUN BENCHMARK node: Deploys a model via the inference engine and runs benchmarks.
 *
 * When engine/sshConfig/hardwareProfile/thresholds are missing, uses stub behavior.
 * Otherwise runs full benchmark with checkpoint recording, auto-stop timer, and
 * Elastic Agent integration.
 */
export async function runBenchmarkNode(
  state: GraphState,
  config: RunnableConfig,
): Promise<GraphStateUpdate> {
  const cfg = getConfigurable(config);
  const {
    engine,
    sshConfig,
    hardwareProfile,
    thresholds,
    resultsStore,
    elasticAgentService,
    queueService,
    maxDeploymentDurationMs,
  } = cfg;

  if (!state.currentModel) {
    logger.error('runBenchmark called without a current model');
    return {
      currentState: 'error',
      error: 'No model selected for benchmarking',
      errorCount: state.errorCount + 1,
      lastErrorCategory: 'unknown',
    };
  }

  // Stub behavior when engine/config not fully configured
  if (!engine || !sshConfig || !hardwareProfile || !thresholds) {
    logger.warn(
      `runBenchmarkNode stub: no engine configured, skipping deployment for ${state.currentModel.id}`,
    );
    return {
      currentState: 'storing_results',
      lastSuccessTimestamp: Date.now(),
      error: null,
      errorCount: 0,
      lastErrorCategory: null,
    };
  }

  const model = state.currentModel;
  const store = resultsStore;
  const eng = engine!;

  try {
    // Check auto-stop before starting
    if (queueService && typeof maxDeploymentDurationMs === 'number' && maxDeploymentDurationMs > 0) {
      const currentEntry = await queueService.getCurrent();
      if (currentEntry && (await queueService.shouldAutoStop(currentEntry.id, maxDeploymentDurationMs))) {
        logger.info(`Auto-stop: deployment duration exceeded for ${model.id}, moving to next model`);
        return {
          currentState: 'evaluating_model',
          lastSuccessTimestamp: Date.now(),
          error: null,
          errorCount: 0,
        };
      }
    }

    // Ensure Elastic Agent is running before deployment
    if (elasticAgentService && sshConfig) {
      const ok = await elasticAgentService.ensureRunning(sshConfig);
      if (!ok) {
        logger.warn('Elastic Agent ensureRunning failed, continuing anyway');
      }
    }

    if (store && typeof store.saveCheckpoint === 'function') {
      await store.saveCheckpoint({
        modelId: model.id,
        eventType: 'deployment_started',
        engineType: eng.engineType,
      } as CheckpointEvent);
    }

    logger.info(`Deploying model via ${eng.engineType}: ${model.id}`);
    const deployment = await eng.deploy(sshConfig, model, hardwareProfile);

    // Checkpoint: deployment_ready
    if (store && typeof store.saveCheckpoint === 'function') {
      await store.saveCheckpoint({
        modelId: model.id,
        eventType: 'deployment_ready',
        engineType: eng.engineType,
        host: sshConfig.host,
        containerId: deployment.deploymentId,
        containerName: deployment.deploymentName,
      } as CheckpointEvent);
    }

    logger.info(`Model deployed successfully: ${model.id}`, {
      deploymentId: deployment.deploymentId,
      apiEndpoint: deployment.apiEndpoint,
      maxModelLen: deployment.maxModelLen,
    });

    // Update queue status to benchmarking
    if (queueService) {
      const currentEntry = await queueService.getCurrent();
      if (currentEntry) {
        await queueService.updateStatus(currentEntry.id, 'benchmarking');
      }
    }

    // Checkpoint: benchmark_started
    if (store && typeof store.saveCheckpoint === 'function') {
      await store.saveCheckpoint({
        modelId: model.id,
        eventType: 'benchmark_started',
        engineType: eng.engineType,
      } as CheckpointEvent);
    }

    logger.info(`Running benchmarks for model: ${model.id}`, {
      deploymentName: deployment.deploymentName,
    });

    const parameterCountBillions =
      model.parameterCount != null
        ? model.parameterCount / 1e9
        : getModelParamsBillions(model.id);

    const engineResult = await eng.runBenchmarks(
      sshConfig,
      model.id,
      thresholds.concurrencyLevels,
      thresholds,
      deployment.deploymentName,
      parameterCountBillions,
    );

    // Checkpoint: benchmark_completed
    if (store && typeof store.saveCheckpoint === 'function') {
      await store.saveCheckpoint({
        modelId: model.id,
        eventType: 'benchmark_completed',
        engineType: eng.engineType,
      } as CheckpointEvent);
    }

    logger.info(`Benchmarks completed for model: ${model.id}`, {
      passed: engineResult.passed,
      runsCompleted: engineResult.runs.length,
    });

    let toolCallResults: ToolCallResult | null = null;
    if (eng.supportsToolCalling(model)) {
      try {
        const toolCallBenchmark = new ToolCallBenchmarkService({
          baseUrl: deployment.apiEndpoint,
          model: model.id,
          logLevel: 'info',
        });
        const toolReport = await toolCallBenchmark.runBenchmark();
        toolCallResults = toolReport.toolCallResult;
        logger.info(`Tool call benchmark completed for ${model.id}`, {
          supportsParallelCalls: toolCallResults.supportsParallelCalls,
          successRate: (toolCallResults.successRate * 100).toFixed(1) + '%',
          totalTests: toolCallResults.totalTests,
        });
      } catch (toolErr) {
        logger.warn(
          `Tool call benchmark failed for ${model.id}, storing without tool call data`,
          {
            error: toolErr instanceof Error ? toolErr.message : String(toolErr),
          },
        );
      }
    } else {
      logger.debug(
        `Skipping tool call benchmark for ${model.id} (engine does not support tool calling)`,
      );
    }

    // Run reasoning benchmark if supported
    let reasoningResults = null;
    if (cfg.reasoningBenchmark) {
      try {
        logger.info(`Running reasoning benchmark for ${model.id}...`);
        reasoningResults = await cfg.reasoningBenchmark.run();
        logger.info(`Reasoning benchmark completed for ${model.id}`, {
          reasoningSupported: reasoningResults.reasoningSupported,
          qualityImprovement: (reasoningResults.qualityImprovement * 100).toFixed(1) + '%',
          recommendation: reasoningResults.recommendation,
        });
      } catch (reasoningErr) {
        logger.warn(
          `Reasoning benchmark failed for ${model.id}, storing without reasoning data`,
          {
            error: reasoningErr instanceof Error ? reasoningErr.message : String(reasoningErr),
          },
        );
      }
    } else {
      logger.debug(`Skipping reasoning benchmark for ${model.id} (not configured)`);
    }

    const benchmarkResult = buildBenchmarkResult(
      model,
      deployment,
      engineResult,
      hardwareProfile,
      toolCallResults,
      reasoningResults,
    );

    return {
      currentState: 'storing_results',
      results: [benchmarkResult],
      lastSuccessTimestamp: Date.now(),
      error: null,
      errorCount: 0,
      lastErrorCategory: null,
    };
  } catch (error) {
    const errorCategory = classifyError(error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(`Benchmark failed for model ${model.id}: ${errorMessage}`, {
      errorCategory,
      engineType: eng.engineType,
    });

    return {
      currentState: 'error',
      error: errorMessage,
      errorCount: state.errorCount + 1,
      lastErrorCategory: errorCategory,
    };
  }
}

/**
 * STORE RESULTS node: Persists benchmark results and marks the model as evaluated.
 */
export async function storeResultsNode(
  state: GraphState,
  config: RunnableConfig,
): Promise<GraphStateUpdate> {
  const cfg = getConfigurable(config);
  const { resultsStore, queueService } = cfg;
  const modelId = state.currentModel?.id;

  const latestResult =
    state.results.length > 0 ? state.results[state.results.length - 1] : undefined;

  if (!latestResult || (modelId && latestResult.modelId !== modelId)) {
    logger.info(
      `No new benchmark result for model: ${modelId ?? 'unknown'}, skipping persist`,
    );
    return {
      currentState: 'evaluating_model',
      lastSuccessTimestamp: Date.now(),
      error: null,
      errorCount: 0,
    };
  }

  if (resultsStore) {
    try {
      await resultsStore.save(latestResult);
      logger.info(`Persisted benchmark result to store for model: ${latestResult.modelId}`);
    } catch (err) {
      logger.error('Failed to persist benchmark result', {
        modelId: latestResult.modelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (queueService && state.currentModel) {
    const currentEntry = await queueService.getCurrent();
    if (currentEntry) {
      await queueService.updateStatus(currentEntry.id, 'completed');
    }
  }

  const newEvaluatedIds = modelId ? [modelId] : [];

  return {
    currentState: 'exposing_api',
    evaluatedModelIds: newEvaluatedIds,
    lastSuccessTimestamp: Date.now(),
    error: null,
    errorCount: 0,
  };
}

/**
 * EXPOSE API node: Uses TunnelService to expose the vLLM API publicly via a tunnel.
 */
export async function exposeApiNode(
  _state: GraphState,
  config: RunnableConfig,
): Promise<GraphStateUpdate> {
  const cfg = getConfigurable(config);
  const { tunnelService } = cfg;

  logger.info('Exposing results via API');

  if (!tunnelService || !tunnelService.enabled) {
    logger.info('Tunnel service is disabled, skipping tunnel creation');
    return {
      currentState: 'running_kibana_eval',
      lastSuccessTimestamp: Date.now(),
      error: null,
      errorCount: 0,
      tunnelUrl: null,
    };
  }

  try {
    const result = await tunnelService.connect();

    if (result.success && result.tunnel) {
      logger.info('Tunnel established for API exposure', {
        publicUrl: result.tunnel.publicUrl,
        provider: result.tunnel.provider,
        reused: result.reused,
      });

      return {
        currentState: 'running_kibana_eval',
        lastSuccessTimestamp: Date.now(),
        error: null,
        errorCount: 0,
        tunnelUrl: result.tunnel.publicUrl,
      };
    }

    logger.warn('Tunnel creation failed, continuing without public URL', {
      error: result.error,
    });

    return {
      currentState: 'running_kibana_eval',
      lastSuccessTimestamp: Date.now(),
      error: null,
      errorCount: 0,
      tunnelUrl: null,
    };
  } catch (error) {
    logger.error('Unexpected error during tunnel creation', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      currentState: 'running_kibana_eval',
      lastSuccessTimestamp: Date.now(),
      error: null,
      errorCount: 0,
      tunnelUrl: null,
    };
  }
}

/**
 * RUN KIBANA EVAL node: Creates Kibana connector and runs evaluation tasks.
 */
export async function runKibanaEvalNode(
  state: GraphState,
  config: RunnableConfig,
): Promise<GraphStateUpdate> {
  const cfg = getConfigurable(config);
  const { kibanaConnectorService, kibanaEvalRunner } = cfg;

  logger.info('Running Kibana evaluation');

  if (!kibanaConnectorService || !kibanaConnectorService.enabled) {
    logger.info('Kibana connector service is disabled, skipping connector creation');
    return {
      currentState: 'evaluating_model',
      lastSuccessTimestamp: Date.now(),
      error: null,
      errorCount: 0,
      kibanaConnectorId: null,
      kibanaEvalReport: null,
    };
  }

  if (!state.tunnelUrl) {
    logger.warn('No tunnel URL available, skipping Kibana connector creation');
    return {
      currentState: 'evaluating_model',
      lastSuccessTimestamp: Date.now(),
      error: null,
      errorCount: 0,
      kibanaConnectorId: null,
      kibanaEvalReport: null,
    };
  }

  if (!state.currentModel) {
    logger.warn('No current model, skipping Kibana connector creation');
    return {
      currentState: 'evaluating_model',
      lastSuccessTimestamp: Date.now(),
      error: null,
      errorCount: 0,
      kibanaConnectorId: null,
      kibanaEvalReport: null,
    };
  }

  let connectorId: string | null = null;

  try {
    const result = await kibanaConnectorService.createConnector({
      apiUrl: state.tunnelUrl,
      modelId: state.currentModel.id,
    });

    if (result.success && result.connector) {
      connectorId = result.connector.id;
      logger.info('Kibana connector created/found for model', {
        connectorId: result.connector.id,
        connectorName: result.connector.name,
        modelId: state.currentModel.id,
        isNewlyCreated: result.connector.isNewlyCreated,
      });
    } else {
      logger.warn('Kibana connector creation failed, continuing without connector', {
        error: result.error,
        modelId: state.currentModel.id,
      });
    }
  } catch (error) {
    logger.error('Unexpected error during Kibana connector creation', {
      error: error instanceof Error ? error.message : String(error),
      modelId: state.currentModel.id,
    });
  }

  if (connectorId && kibanaEvalRunner && kibanaEvalRunner.enabled) {
    try {
      logger.info('Running Kibana evaluation tasks', {
        connectorId,
        modelId: state.currentModel.id,
      });

      const evalReport = await kibanaEvalRunner.runEvaluation({
        connectorId,
        modelId: state.currentModel.id,
      });

      logger.info('Kibana evaluation completed', {
        modelId: state.currentModel.id,
        classification: evalReport.classification,
        percentageScore: evalReport.scoring.percentageScore,
        passedCount: evalReport.scoring.passedCount,
        totalCount: evalReport.scoring.totalCount,
      });

      return {
        currentState: 'evaluating_model',
        lastSuccessTimestamp: Date.now(),
        error: null,
        errorCount: 0,
        kibanaConnectorId: connectorId,
        kibanaEvalReport: evalReport,
        kibanaEvalReports: [evalReport],
      };
    } catch (error) {
      logger.error('Kibana evaluation failed, continuing without eval results', {
        error: error instanceof Error ? error.message : String(error),
        modelId: state.currentModel.id,
      });
    }
  } else if (connectorId && (!kibanaEvalRunner || !kibanaEvalRunner.enabled)) {
    logger.info('Kibana eval runner is not available or disabled, skipping evaluation tasks');
  }

  return {
    currentState: 'evaluating_model',
    lastSuccessTimestamp: Date.now(),
    error: null,
    errorCount: 0,
    kibanaConnectorId: connectorId,
    kibanaEvalReport: null,
  };
}

/**
 * ERROR HANDLER node: Handles errors and decides whether to retry or stop.
 */
export async function handleErrorNode(
  state: GraphState,
  config: RunnableConfig,
): Promise<GraphStateUpdate> {
  const cfg = getConfigurable(config);
  const { resultsStore, queueService } = cfg;
  const count = state.errorCount;
  const errorCategory = state.lastErrorCategory ?? 'unknown';
  const modelId = state.currentModel?.id ?? 'unknown';

  const saveError = async (recoveryRecord: {
    modelId: string;
    errorCategory: string;
    recoveryAction: string;
    attemptNumber: number;
    success: boolean;
    nodeName: string;
    message: string;
  }) => {
    if (resultsStore && typeof resultsStore.saveError === 'function') {
      await resultsStore.saveError({
        modelId: recoveryRecord.modelId,
        errorCategory: recoveryRecord.errorCategory,
        errorMessage: state.error ?? '',
        recoveryAction: recoveryRecord.recoveryAction,
        attemptNumber: recoveryRecord.attemptNumber,
        success: recoveryRecord.success,
        nodeName: recoveryRecord.nodeName,
      });
    }
  };

  // OOM and fatal model errors → skip model, continue with next
  if (errorCategory === 'oom' || errorCategory === 'fatal_model_error') {
    logger.warn(`Skipping model ${modelId} due to ${errorCategory}: ${state.error}`, {
      errorCategory,
    });

    const recoveryRecord = {
      modelId,
      errorCategory,
      recoveryAction: 'skip_model' as const,
      success: false,
      attemptNumber: state.currentModelRetryCount,
      timestamp: Date.now(),
      message: `Model skipped due to ${errorCategory}: ${state.error}`,
    };

    await saveError({
      ...recoveryRecord,
      nodeName: 'handle_error',
    });

    if (queueService && modelId !== 'unknown') {
      const currentEntry = await queueService.getCurrent();
      if (currentEntry) {
        await queueService.updateStatus(currentEntry.id, 'failed', state.error ?? undefined);
      }
    }

    const skipModelIds = modelId !== 'unknown' ? [modelId] : [];
    return {
      currentState: 'evaluating_model',
      skippedModelIds: skipModelIds,
      recoveryRecords: [recoveryRecord],
      currentModelRetryCount: 0,
      lastErrorCategory: null,
    };
  }

  // Check if max errors reached → terminal state
  if (count >= MAX_ERROR_COUNT) {
    logger.error(`Max error count (${MAX_ERROR_COUNT}) reached. Agent stopping.`, {
      lastError: state.error,
      lastErrorCategory: errorCategory,
    });

    const recoveryRecord = {
      modelId,
      errorCategory,
      recoveryAction: 'abort' as const,
      success: false,
      attemptNumber: count,
      timestamp: Date.now(),
      message: `Max error count (${MAX_ERROR_COUNT}) reached. Agent stopping.`,
    };

    await saveError({
      ...recoveryRecord,
      nodeName: 'handle_error',
    });

    return {
      currentState: 'error',
      recoveryRecords: [recoveryRecord],
    };
  }

  // Docker crashes and SSH failures → retry from idle
  if (errorCategory === 'docker_crash' || errorCategory === 'ssh_connection') {
    const retryCount = state.currentModelRetryCount;
    const maxRetries = errorCategory === 'docker_crash' ? 2 : 3;

    if (retryCount < maxRetries) {
      logger.warn(
        `${errorCategory} error (retry ${retryCount + 1}/${maxRetries}), will retry model ${modelId}`,
        { error: state.error },
      );

      const recoveryRecord = {
        modelId,
        errorCategory,
        recoveryAction:
          errorCategory === 'docker_crash'
            ? ('cleanup_and_retry' as const)
            : ('retry_with_backoff' as const),
        success: false,
        attemptNumber: retryCount + 1,
        timestamp: Date.now(),
        message: `Retrying ${errorCategory} (attempt ${retryCount + 1}/${maxRetries})`,
      };

      return {
        currentState: 'idle',
        currentModelRetryCount: retryCount + 1,
        recoveryRecords: [recoveryRecord],
        lastErrorCategory: null,
      };
    }

    logger.warn(`Max retries for ${errorCategory} exhausted, skipping model ${modelId}`);
    const skipModelIds = modelId !== 'unknown' ? [modelId] : [];
    const recoveryRecord = {
      modelId,
      errorCategory,
      recoveryAction: 'skip_model' as const,
      success: false,
      attemptNumber: retryCount + 1,
      timestamp: Date.now(),
      message: `Max retries exhausted for ${errorCategory}, skipping model`,
    };

    await saveError({
      ...recoveryRecord,
      nodeName: 'handle_error',
    });

    if (queueService && modelId !== 'unknown') {
      const currentEntry = await queueService.getCurrent();
      if (currentEntry) {
        await queueService.updateStatus(currentEntry.id, 'failed', state.error ?? undefined);
      }
    }

    return {
      currentState: 'evaluating_model',
      skippedModelIds: skipModelIds,
      recoveryRecords: [recoveryRecord],
      currentModelRetryCount: 0,
      lastErrorCategory: null,
    };
  }

  // Benchmark timeout → graceful terminate and retry or skip
  if (errorCategory === 'benchmark_timeout' || errorCategory === 'ssh_timeout') {
    const retryCount = state.currentModelRetryCount;

    if (retryCount < 1) {
      logger.warn(`Timeout error, will retry model ${modelId} once`, {
        error: state.error,
      });

      const recoveryRecord = {
        modelId,
        errorCategory,
        recoveryAction: 'graceful_terminate' as const,
        success: false,
        attemptNumber: retryCount + 1,
        timestamp: Date.now(),
        message: `Timeout for ${modelId}, retrying once after graceful termination`,
      };

      return {
        currentState: 'idle',
        currentModelRetryCount: retryCount + 1,
        recoveryRecords: [recoveryRecord],
        lastErrorCategory: null,
      };
    }

    logger.warn(`Timeout retry exhausted, skipping model ${modelId}`);
    const skipModelIds = modelId !== 'unknown' ? [modelId] : [];
    const recoveryRecord = {
      modelId,
      errorCategory,
      recoveryAction: 'skip_model' as const,
      success: false,
      attemptNumber: retryCount + 1,
      timestamp: Date.now(),
      message: `Timeout retry exhausted, skipping model`,
    };

    await saveError({
      ...recoveryRecord,
      nodeName: 'handle_error',
    });

    if (queueService && modelId !== 'unknown') {
      const currentEntry = await queueService.getCurrent();
      if (currentEntry) {
        await queueService.updateStatus(currentEntry.id, 'failed', state.error ?? undefined);
      }
    }

    return {
      currentState: 'evaluating_model',
      skippedModelIds: skipModelIds,
      recoveryRecords: [recoveryRecord],
      currentModelRetryCount: 0,
      lastErrorCategory: null,
    };
  }

  // Default: retry from idle with error count tracking
  logger.warn(`Error occurred (${count}/${MAX_ERROR_COUNT}), will retry from idle`, {
    error: state.error,
    errorCategory,
  });

  const recoveryRecord = {
    modelId,
    errorCategory,
    recoveryAction: 'retry_with_backoff' as const,
    success: false,
    attemptNumber: count,
    timestamp: Date.now(),
    message: `Retrying from idle (error ${count}/${MAX_ERROR_COUNT})`,
  };

  await saveError({
    ...recoveryRecord,
    nodeName: 'handle_error',
  });

  return {
    currentState: 'idle',
    recoveryRecords: [recoveryRecord],
    lastErrorCategory: null,
  };
}

// ─── Routing Functions ──────────────────────────────────────────────────────

/**
 * Routes from the evaluate_model node based on whether there are
 * unevaluated models remaining.
 */
export function routeAfterEvaluation(state: GraphState): string {
  if (state.currentState === 'idle') {
    return 'idle';
  }
  return 'run_benchmark';
}

/**
 * Routes from the run_benchmark node based on whether an error occurred.
 */
export function routeAfterBenchmark(state: GraphState): string {
  if (state.currentState === 'error') {
    return 'handle_error';
  }
  return 'store_results';
}

/**
 * DISCOVER PROMISING MODELS node: Autonomously discovers and queues promising new models from HuggingFace.
 */
export async function discoverPromisingModelsNode(
  state: GraphState,
  config: RunnableConfig,
): Promise<GraphStateUpdate> {
  const cfg = getConfigurable(config);
  const { queueService, resultsStore } = cfg;

  logger.info('[discover_promising_models] Searching for new models...');

  // Import HuggingFace API
  const { listModels } = await import('@huggingface/hub');

  try {
    // Fetch recent text-generation models from HuggingFace
    const models = [];
    for await (const model of listModels({
      search: { task: 'text-generation' },
      sort: 'likes',
      limit: 100,
      credentials: cfg.huggingfaceToken ? { accessToken: cfg.huggingfaceToken } : undefined,
    })) {
      models.push(model);
    }

    // Parallel evaluation with concurrency limit
    const limit = pLimit(DISCOVERY_CONCURRENCY.MAX_CONCURRENT_EVALUATIONS);
    const capDetection = new CapabilityDetectionService();
    const configResearcher = new ConfigResearcherService({
      gpusAvailable: cfg.hardwareProfile?.gpuCount || 2,
      huggingfaceToken: cfg.huggingfaceToken,
    });

    const candidateModels = models.slice(0, MAX_MODELS_TO_EVALUATE);

    logger.info(`[discover_promising_models] Evaluating ${candidateModels.length} models in parallel`, {
      concurrency: DISCOVERY_CONCURRENCY.MAX_CONCURRENT_EVALUATIONS,
    });

    const evalResults = await Promise.all(
      candidateModels.map(model =>
        limit(async () => {
          try {
            // Skip if already benchmarked
            if (resultsStore) {
              try {
                const existing = await resultsStore.getModelSummary(model.id);
                if (existing) {
                  logger.debug(`[discover_promising_models] Skipping ${model.id} - already benchmarked`);
                  return null;
                }
              } catch {
                // Model not found, continue with evaluation
              }
            }

            // Parallel capability and config checks
            const [caps, modelConfig] = await Promise.all([
              capDetection.detect(model.id),
              configResearcher.research(model.id),
            ]);

            // Filter by capabilities
            if (!caps.toolCalling.supported && !caps.reasoning.supported) {
              logger.debug(`[discover_promising_models] Skipping ${model.id} - no tool calling or reasoning`);
              return null;
            }

            // Filter by hardware fit
            if (modelConfig.tensorParallelSize > (cfg.hardwareProfile?.gpuCount || 2)) {
              logger.debug(`[discover_promising_models] Skipping ${model.id} - requires ${modelConfig.tensorParallelSize} GPUs`);
              return null;
            }

            // Score model using weighted criteria
            const score =
              (caps.toolCalling.supported ? SCORING_WEIGHTS.TOOL_CALLING : 0) +
              (caps.reasoning.supported ? SCORING_WEIGHTS.REASONING : 0) +
              ((model.likes || 0) / SCORING_WEIGHTS.LIKES_DIVISOR) +
              ((model.downloads || 0) / SCORING_WEIGHTS.DOWNLOADS_DIVISOR);

            logger.debug(`[discover_promising_models] ${model.id} scored ${score.toFixed(1)}`, {
              toolCalling: caps.toolCalling.supported,
              reasoning: caps.reasoning.supported,
              likes: model.likes,
            });

            return { model, score };
          } catch (error) {
            logger.warn(`[discover_promising_models] Failed to evaluate ${model.id}`, {
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          }
        })
      )
    );

    // Filter out nulls and sort by score
    const promising = evalResults.filter((r): r is { model: any; score: number } => r !== null);

    // Add top models to queue (with deduplication)
    if (queueService) {
      // Check what's already in queue to avoid duplicates
      const currentQueue = await queueService.getQueue({ status: 'pending' });
      const queuedModelIds = new Set(currentQueue.map(e => e.modelId));

      const topModels = promising
        .sort((a, b) => b.score - a.score)
        .filter(({ model }) => {
          if (queuedModelIds.has(model.id)) {
            logger.debug(`[discover_promising_models] Skipping ${model.id} - already in queue`);
            return false;
          }
          return true;
        })
        .slice(0, TOP_MODELS_TO_QUEUE);

      for (const { model } of topModels) {
        await queueService.enqueue(
          model.id,
          'discovery',
          50,
          'langgraph'
        );
        logger.info('[discover_promising_models] Queued', { modelId: model.id });
      }

      logger.info(`[discover_promising_models] Queued ${topModels.length} promising models`);
    }

    return {
      currentState: 'evaluating_model',
      lastSuccessTimestamp: Date.now(),
    };
  } catch (error) {
    logger.error('[discover_promising_models] Failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      currentState: 'error',
      error: 'Model discovery failed',
      errorCount: state.errorCount + 1,
      lastErrorCategory: 'unknown',
    };
  }
}

/**
 * Routes from idle to choose discovery strategy.
 * Uses autonomous discovery (discover_promising_models) by default,
 * or manual discovery (discover_models) if explicitly configured.
 */
export function routeFromIdle(_state: GraphState): string {
  // For now, default to autonomous discovery
  // This can be made configurable via state or config in the future
  return 'discover_promising_models';
}

/**
 * Routes from the error handler based on error count and recovery decision.
 */
export function routeAfterError(state: GraphState): string {
  if (state.currentState === 'error') {
    return '__end__';
  }
  if (state.currentState === 'evaluating_model') {
    return 'evaluate_model';
  }
  return 'idle';
}
