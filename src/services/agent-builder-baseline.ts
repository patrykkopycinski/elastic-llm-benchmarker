import type { ModelInfo } from '../types/benchmark.js';
import type { AppConfig } from '../types/config.js';
import { HFCardParser } from './hf-card-parser.js';
import {
  ModelCandidateFilter,
  type FilterResult,
} from './model-candidate-filter.js';

/**
 * Minimum model requirements for Kibana Agent Builder + @kbn/evals CI runs.
 *
 * Derived from elastic/security-team#15545 Model Evaluation Log, adjusted for
 * Agent Builder reality: single-tool calling via vLLM (not parallel/multi-tool).
 */
export function createAgentBuilderFilter(config: AppConfig): ModelCandidateFilter {
  const baseline = config.agentBuilderBaseline;
  return new ModelCandidateFilter(config.logLevel, {
    minContextWindow: baseline.minContextWindow,
    targetHardwareProfile: config.vmHardwareProfile,
    requireToolCalling: baseline.requireToolCalling,
    minParameterCountBillions: baseline.minParameterCountBillions,
    requireInstructVariant: baseline.requireInstructVariant,
    checkKnownFailures: true,
  });
}

export async function resolveModelInfo(
  modelId: string,
  config: AppConfig,
): Promise<ModelInfo | null> {
  const parser = new HFCardParser();
  try {
    const parsed = await parser.parse({
      modelId,
      hfApiToken: config.huggingfaceToken,
    });
    const { card } = parsed;
    return {
      id: card.modelId,
      name: card.name,
      architecture: card.architecture,
      contextWindow: card.contextWindow,
      license: card.license,
      parameterCount: card.parameterCount,
      quantizations: card.quantizations,
      supportsToolCalling: card.supportsToolCalling,
    };
  } catch {
    return null;
  }
}

export async function evaluateAgentBuilderBaseline(
  modelId: string,
  config: AppConfig,
): Promise<{ model: ModelInfo | null; filter: FilterResult | null }> {
  if (!config.agentBuilderBaseline.enabled) {
    return { model: null, filter: null };
  }

  const model = await resolveModelInfo(modelId, config);
  if (!model) {
    return { model: null, filter: null };
  }

  const candidateFilter = createAgentBuilderFilter(config);
  return { model, filter: candidateFilter.evaluate(model) };
}

export function formatBaselineRejections(filter: FilterResult): string {
  return filter.rejections.map((r) => `${r.criterion}: ${r.reason}`).join('; ');
}
