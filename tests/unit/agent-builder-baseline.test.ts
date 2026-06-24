import { describe, it, expect } from 'vitest';
import {
  enrichModelInfoFromHfConfig,
  extractContextWindowFromHfConfig,
  estimateParameterCountFromHfConfig,
  inferToolCallingSupport,
  normalizeParameterCount,
} from '../../src/services/agent-builder-baseline.js';
import type { ModelInfo } from '../../src/types/benchmark.js';

describe('agent-builder-baseline enrich', () => {
  it('extracts 128K+ context from rope_scaling in config.json', () => {
    const window = extractContextWindowFromHfConfig({
      max_position_embeddings: 32768,
      rope_scaling: { factor: 4, original_max_position_embeddings: 32768 },
    });
    expect(window).toBe(131072);
  });

  it('estimates parameter count from model id when config lacks num_parameters', () => {
    const count = estimateParameterCountFromHfConfig('Qwen/Qwen2.5-7B-Instruct', {});
    expect(count).toBe(7_000_000_000);
  });

  it('infers tool calling for instruct Qwen models', () => {
    const model: ModelInfo = {
      id: 'Qwen/Qwen2.5-7B-Instruct',
      name: 'Qwen2.5-7B-Instruct',
      architecture: 'qwen2',
      contextWindow: 32768,
      license: 'apache-2.0',
      parameterCount: null,
      quantizations: ['fp16'],
      supportsToolCalling: false,
    };
    expect(inferToolCallingSupport(model)).toBe(true);
  });

  it('normalizes billions from HF card parser into raw parameter count', () => {
    expect(normalizeParameterCount(7)).toBe(7_000_000_000);
    expect(normalizeParameterCount(7_000_000_000)).toBe(7_000_000_000);
    expect(normalizeParameterCount(null)).toBeNull();
  });

  it('enriches incomplete card metadata from config.json', () => {
    const model: ModelInfo = {
      id: 'Qwen/Qwen2.5-7B-Instruct',
      name: 'Qwen2.5-7B-Instruct',
      architecture: 'qwen2',
      contextWindow: 32768,
      license: 'apache-2.0',
      parameterCount: null,
      quantizations: ['fp16'],
      supportsToolCalling: false,
    };

    const enriched = enrichModelInfoFromHfConfig(model, {
      model_type: 'qwen2',
      max_position_embeddings: 32768,
      rope_scaling: { factor: 4, original_max_position_embeddings: 32768 },
    });

    expect(enriched.contextWindow).toBeGreaterThanOrEqual(128_000);
    expect(enriched.parameterCount).toBe(7_000_000_000);
    expect(enriched.supportsToolCalling).toBe(true);
  });
});
