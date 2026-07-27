import type { ModelInfo } from '../types/benchmark.js';
import type { AppConfig } from '../types/config.js';
import { HFCardParser } from './hf-card-parser.js';
import { extractContextWindowFromConfig, normalizeArchitectureFromConfig } from './hf-config-utils.js';
import {
  ModelCandidateFilter,
  type FilterResult,
} from './model-candidate-filter.js';
import { getVllmParamsForModel } from './vllm-model-params.js';

/** Minimal config.json shape used to enrich HF card metadata for baseline checks. */
export interface HfConfigJson {
  model_type?: string;
  architectures?: string[];
  max_position_embeddings?: number;
  max_sequence_length?: number;
  sliding_window?: number;
  rope_scaling?: {
    factor?: number;
    original_max_position_embeddings?: number;
  };
  num_hidden_layers?: number;
  hidden_size?: number;
  vocab_size?: number;
  num_parameters?: number;
  intermediate_size?: number;
  /** VLM/multimodal models nest text-model params here (e.g. Qwen3.5, Qwen3-VL). */
  text_config?: {
    max_position_embeddings?: number;
    max_sequence_length?: number;
    num_hidden_layers?: number;
    hidden_size?: number;
    vocab_size?: number;
    intermediate_size?: number;
    num_experts?: number;
    num_experts_per_tok?: number;
    rope_scaling?: {
      factor?: number;
      original_max_position_embeddings?: number;
    };
  };
}

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
    minActiveParametersBillions: baseline.minActiveParametersBillions,
    requireInstructVariant: baseline.requireInstructVariant,
    checkKnownFailures: true,
  });
}

export function normalizeParameterCount(raw: number | null): number | null {
  if (raw === null) return null;
  // HFCardParser returns billions (e.g. 7 for 7B); ModelInfo uses raw parameter count.
  if (raw > 0 && raw < 1000) {
    return raw * 1_000_000_000;
  }
  return raw;
}

export function extractContextWindowFromHfConfig(config: HfConfigJson): number {
  return extractContextWindowFromConfig(config as Record<string, unknown>);
}

export function normalizeArchitectureFromHfConfig(config: HfConfigJson): string | null {
  return normalizeArchitectureFromConfig(config as Record<string, unknown>);
}

export function estimateParameterCountFromHfConfig(
  modelId: string,
  config: HfConfigJson,
): number | null {
  if (typeof config.num_parameters === 'number') {
    const np = config.num_parameters;
    return np >= 1_000_000_000 ? np : np * 1_000_000_000;
  }

  if (
    typeof config.hidden_size === 'number' &&
    typeof config.num_hidden_layers === 'number'
  ) {
    const h = config.hidden_size;
    const l = config.num_hidden_layers;
    const v = typeof config.vocab_size === 'number' ? config.vocab_size : 0;
    const i =
      typeof config.intermediate_size === 'number' ? config.intermediate_size : h * 4;
    return v * h + l * (4 * h * h + 3 * h * i);
  }

  const idMatch = modelId.match(/(\d+(?:\.\d+)?)[bB](?:\b|[-_]|$)/);
  if (idMatch?.[1]) {
    return parseFloat(idMatch[1]) * 1_000_000_000;
  }

  return null;
}

export function inferToolCallingSupport(model: ModelInfo): boolean {
  if (model.supportsToolCalling) return true;

  // If vLLM has a known tool-call parser for this model, it supports tool calling
  // regardless of naming convention (covers base models like Qwen3.6-35B-A3B).
  const vllmParams = getVllmParamsForModel(model.id, model.architecture);
  if (vllmParams.toolCallParser !== null) return true;

  const id = model.id.toLowerCase();
  const instructIndicators = ['instruct', 'chat', '-it', '_it'];
  if (!instructIndicators.some((s) => id.includes(s))) {
    return false;
  }

  const arch = model.architecture.toLowerCase();
  const families = ['qwen', 'llama', 'mistral', 'mixtral', 'codellama', 'hermes'];
  return families.some((f) => arch.includes(f) || id.includes(f));
}

/** Merge config.json fields into card-derived ModelInfo (card alone is often incomplete). */
export function enrichModelInfoFromHfConfig(
  model: ModelInfo,
  hfConfig: HfConfigJson,
): ModelInfo {
  const contextFromConfig = extractContextWindowFromHfConfig(hfConfig);
  const archFromConfig = normalizeArchitectureFromHfConfig(hfConfig);
  const paramsFromConfig = estimateParameterCountFromHfConfig(model.id, hfConfig);
  const normalizedCardParams = normalizeParameterCount(model.parameterCount);

  const enriched: ModelInfo = {
    ...model,
    architecture: archFromConfig ?? model.architecture,
    contextWindow: Math.max(model.contextWindow, contextFromConfig),
    parameterCount:
      normalizedCardParams && normalizedCardParams >= 1_000_000_000
        ? normalizedCardParams
        : (paramsFromConfig ?? normalizedCardParams),
  };

  return {
    ...enriched,
    supportsToolCalling: inferToolCallingSupport(enriched),
  };
}

export async function resolveModelInfo(
  modelId: string,
  config: AppConfig,
  hfConfig?: HfConfigJson | null,
): Promise<ModelInfo | null> {
  const parser = new HFCardParser();
  try {
    const parsed = await parser.parse({
      modelId,
      hfApiToken: config.huggingfaceToken,
    });
    const { card } = parsed;
    let model: ModelInfo = {
      id: card.modelId,
      name: card.name,
      architecture: card.architecture,
      contextWindow: card.contextWindow,
      license: card.license,
      parameterCount: normalizeParameterCount(card.parameterCount),
      quantizations: card.quantizations,
      supportsToolCalling: card.supportsToolCalling,
    };

    if (hfConfig) {
      model = enrichModelInfoFromHfConfig(model, hfConfig);
    } else {
      model = { ...model, supportsToolCalling: inferToolCallingSupport(model) };
    }

    return model;
  } catch {
    return null;
  }
}

export async function evaluateAgentBuilderBaseline(
  modelId: string,
  config: AppConfig,
  hfConfig?: HfConfigJson | null,
): Promise<{ model: ModelInfo | null; filter: FilterResult | null }> {
  if (!config.agentBuilderBaseline.enabled) {
    return { model: null, filter: null };
  }

  const model = await resolveModelInfo(modelId, config, hfConfig);
  if (!model) {
    return { model: null, filter: null };
  }

  const candidateFilter = createAgentBuilderFilter(config);
  return { model, filter: candidateFilter.evaluate(model) };
}

export function formatBaselineRejections(filter: FilterResult): string {
  return filter.rejections.map((r) => `${r.criterion}: ${r.reason}`).join('; ');
}
