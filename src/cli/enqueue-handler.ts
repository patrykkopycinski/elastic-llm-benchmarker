import type { Client } from '@elastic/elasticsearch';
import { QueueService } from '../services/queue-service.js';
import { HardwareEstimator } from '../services/hardware-estimator.js';
import { HardwareProfileRegistry } from '../services/hardware-profiles.js';
import { ModelDiscoveryService } from '../services/model-discovery.js';
import {
  evaluateAgentBuilderBaseline,
  formatBaselineRejections,
} from '../services/agent-builder-baseline.js';
import type { AppConfig } from '../types/config.js';

export interface EnqueueOptions {
  modelId: string;
  hardwareProfileId?: string;
  priority?: number;
  force?: boolean;
  reason?: string;
  config: AppConfig;
  esClient: Client;
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

/**
 * Enqueue a model for benchmarking with an optional hardware-fit dry-run.
 *
 * If `force` is not set and the model config cannot be fetched or the model
 * does not fit the target hardware profile, the operation fails with a
 * descriptive message.
 */
export async function runEnqueue(options: EnqueueOptions): Promise<EnqueueResult> {
  const { modelId, config, esClient } = options;
  const hardwareProfileId = options.hardwareProfileId ?? config.hardwareProfileId ?? '2xa100-80gb';
  const priority = options.priority ?? 5;
  const force = options.force ?? false;
  const reason = options.reason;

  const queueService = new QueueService(esClient);
  const estimator = new HardwareEstimator();
  const profileRegistry = new HardwareProfileRegistry();
  const modelDiscovery = new ModelDiscoveryService(
    config.huggingfaceToken,
    [],
    config.logLevel ?? 'info',
  );

  // Fetch model config from HuggingFace
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

  // Agent Builder baseline gate (pre-deploy filter)
  if (config.agentBuilderBaseline.enabled && !force) {
    const { model, filter } = await evaluateAgentBuilderBaseline(modelId, config);
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
  }

  // Resolve hardware profile
  const profile = profileRegistry.getProfile(hardwareProfileId);
  if (!profile) {
    return {
      success: false,
      message: `Hardware profile '${hardwareProfileId}' not found.`,
    };
  }

  // Run dry-run hardware fit check
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

  // Enqueue (with or without force override)
  const entry = await queueService.enqueue(modelId, 'user', priority, undefined, {
    hardwareProfileId,
    estimatedGb: dryRun.estimatedGb,
    fits: dryRun.fits,
    force,
    reason:
      reason ??
      `estimated ${dryRun.estimatedGb.toFixed(2)} GB / available ${dryRun.availableGb.toFixed(2)} GB`,
  });

  return {
    success: true,
    entryId: entry.id,
    message: `Enqueued ${modelId} with hardware profile ${hardwareProfileId}${!dryRun.fits ? ' (forced)' : ''}. ` +
      `Estimated ${dryRun.estimatedGb.toFixed(2)} GB / available ${dryRun.availableGb.toFixed(2)} GB`,
    dryRun,
  };
}
