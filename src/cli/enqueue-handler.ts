import type { Client } from '@elastic/elasticsearch';
import { QueueService } from '../services/queue-service.js';
import { HardwareEstimator } from '../services/hardware-estimator.js';
import { HardwareProfileRegistry } from '../services/hardware-profiles.js';
import { ModelDiscoveryService } from '../services/model-discovery.js';
import {
  evaluateAgentBuilderBaseline,
  formatBaselineRejections,
} from '../services/agent-builder-baseline.js';
import { deriveModelFamily } from '../services/discovery-scheduler.js';
import type { AppConfig } from '../types/config.js';

export interface EnqueueOptions {
  modelId: string;
  hardwareProfileId?: string;
  priority?: number;
  force?: boolean;
  reason?: string;
  config: AppConfig;
  esClient: Client;
  /** Skip Stage 1; run evals against an existing vLLM endpoint. */
  skipStage1?: boolean;
  /** Required when skipStage1 is true. */
  endpointUrl?: string;
  /** Optional deployment name for teardown when skipStage1 is true. */
  deploymentName?: string;
  /** Resume evals: skip suites already passed in batch jsonl / ES for this model. */
  skipPassedSuites?: boolean;
}

export interface EnqueueResult {
  success: boolean;
  entryId?: string;
  message: string;
  dryRun?: {
    fits: boolean;
    estimatedGb: number;
    availableGb: number;
    reason: string;
  };
}

async function findFamilyDedupConflict(
  queueService: QueueService,
  modelId: string,
  config: AppConfig,
  force: boolean,
): Promise<string | null> {
  if (force) return null;
  const family = deriveModelFamily(modelId);
  const inFlight = await queueService.findNonTerminalEntries();
  for (const entry of inFlight) {
    if (deriveModelFamily(entry.modelId) === family) {
      return `Family ${family} already has in-flight entry for ${entry.modelId} (${entry.status})`;
    }
  }

  const days = config.discoveryScheduler?.skipRecentlyBenchmarkedDays ?? 30;
  if (days > 0) {
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const recent = await queueService.findRecentTerminalModelIds(sinceIso);
    for (const recentId of recent) {
      if (deriveModelFamily(recentId) === family && recentId !== modelId) {
        return `Family ${family} was benchmarked recently via ${recentId} (within ${days}d window)`;
      }
    }
  }

  return null;
}

/**
 * Enqueue a model for benchmarking with an optional hardware-fit dry-run.
 */
export async function runEnqueue(options: EnqueueOptions): Promise<EnqueueResult> {
  const { modelId, config, esClient } = options;
  const hardwareProfileId = options.hardwareProfileId ?? config.hardwareProfileId ?? '2xa100-80gb';
  const priority = options.priority ?? 5;
  const force = options.force ?? false;
  const reason = options.reason;
  const skipStage1 = options.skipStage1 ?? false;
  const endpointUrl = options.endpointUrl;
  const deploymentName = options.deploymentName;
  const skipPassedSuites = options.skipPassedSuites ?? skipStage1;

  if (skipStage1 && !endpointUrl) {
    return {
      success: false,
      message: '--skip-stage1 requires --endpoint-url',
    };
  }

  const queueService = new QueueService(esClient);

  const familyConflict = await findFamilyDedupConflict(queueService, modelId, config, force);
  if (familyConflict) {
    return { success: false, message: familyConflict };
  }

  const estimator = new HardwareEstimator();
  const profileRegistry = new HardwareProfileRegistry();
  const modelDiscovery = new ModelDiscoveryService(
    config.huggingfaceToken,
    [],
    config.logLevel ?? 'info',
  );

  if (skipStage1) {
    const entry = await queueService.enqueue(modelId, 'user', priority, undefined, {
      hardwareProfileId,
      estimatedGb: null,
      fits: true,
      force,
      reason: reason ?? `eval-only against ${endpointUrl}`,
      skipStage1: true,
      endpointUrl,
      deploymentName,
      skipPassedSuites,
    });
    return {
      success: true,
      entryId: entry.id,
      message: `Enqueued ${modelId} for eval-only (Stage 1 skipped) at ${endpointUrl}`,
    };
  }

  const modelConfig = await modelDiscovery.fetchModelConfig(modelId);

  if (!modelConfig && !force) {
    return {
      success: false,
      message: `Could not fetch config.json for ${modelId}. Use --force to enqueue anyway.`,
    };
  }

  if (!modelConfig && force) {
    const entry = await queueService.enqueue(modelId, 'user', priority, undefined, {
      hardwareProfileId,
      estimatedGb: null,
      fits: null,
      force: true,
      reason: reason ?? 'config.json not available, forced enqueue',
    });
    return {
      success: true,
      entryId: entry.id,
      message: `Enqueued ${modelId} (forced, no config.json available) with hardware profile ${hardwareProfileId}`,
    };
  }

  let baselineWarnings: string[] | undefined;
  if (config.agentBuilderBaseline.enabled && !force) {
    const { model, filter } = await evaluateAgentBuilderBaseline(modelId, config, modelConfig ?? undefined);
    if (model && filter && !filter.passed) {
      return {
        success: false,
        message:
          `Model ${modelId} does not meet Agent Builder baseline requirements: ${formatBaselineRejections(filter)}. ` +
          'Use --force to enqueue anyway.',
      };
    }
    if (!model && !force) {
      return {
        success: false,
        message:
          `Could not resolve model metadata for ${modelId} (Agent Builder baseline check). Use --force to enqueue anyway.`,
      };
    }
    if (filter && filter.warnings.length > 0) {
      baselineWarnings = filter.warnings.map((w) => `${w.criterion}: ${w.reason}`);
    }
  }

  const profile = profileRegistry.getProfile(hardwareProfileId);
  if (!profile) {
    return {
      success: false,
      message: `Hardware profile '${hardwareProfileId}' not found.`,
    };
  }

  const dryRun = estimator.dryRunCheck(modelConfig!, profile.hardware);

  if (!dryRun.fits && !force) {
    return {
      success: false,
      message:
        `Hardware fit check failed for ${modelId} on profile ${hardwareProfileId}: ${dryRun.reason} ` +
        `(estimated ${dryRun.estimatedGb.toFixed(2)} GB vs available ${dryRun.availableGb.toFixed(2)} GB)`,
      dryRun,
    };
  }

  const entry = await queueService.enqueue(modelId, 'user', priority, undefined, {
    hardwareProfileId,
    estimatedGb: dryRun.estimatedGb,
    fits: dryRun.fits,
    force,
    reason:
      reason ??
      `estimated ${dryRun.estimatedGb.toFixed(2)} GB / available ${dryRun.availableGb.toFixed(2)} GB`,
    skipPassedSuites: options.skipPassedSuites,
    ...(baselineWarnings ? { baselineWarnings } : {}),
  });

  return {
    success: true,
    entryId: entry.id,
    message: `Enqueued ${modelId} with hardware profile ${hardwareProfileId}${!dryRun.fits ? ' (forced)' : ''}. ` +
      `Estimated ${dryRun.estimatedGb.toFixed(2)} GB / available ${dryRun.availableGb.toFixed(2)} GB`,
    dryRun,
  };
}
