import { describe, it, expect } from 'vitest';
import {
  extractContextWindowFromConfig,
  normalizeArchitectureFromConfig,
  resolveEffectiveHfConfig,
} from '../../src/services/hf-config-utils.js';

describe('extractContextWindowFromConfig', () => {
  it('reads max_position_embeddings from top-level config', () => {
    expect(extractContextWindowFromConfig({ max_position_embeddings: 131072 })).toBe(131072);
  });

  it('falls back to text_config.max_position_embeddings for VLM-wrapped configs (regression: Mistral-Small-3.2-24B-Instruct-2506 / Qwen3.6-*-style configs)', () => {
    const config = {
      model_type: 'mistral3',
      text_config: { max_position_embeddings: 262144 },
    };
    expect(extractContextWindowFromConfig(config)).toBe(262144);
  });

  it('prefers top-level max_position_embeddings over text_config when both are present', () => {
    const config = {
      max_position_embeddings: 4096,
      text_config: { max_position_embeddings: 262144 },
    };
    expect(extractContextWindowFromConfig(config)).toBe(4096);
  });

  it('falls back to n_positions when max_position_embeddings is absent', () => {
    expect(extractContextWindowFromConfig({ n_positions: 8192 })).toBe(8192);
  });

  it('falls back to max_sequence_length when others are absent', () => {
    expect(extractContextWindowFromConfig({ max_sequence_length: 16384 })).toBe(16384);
  });

  it('extends window via top-level sliding_window when larger than max_position_embeddings', () => {
    expect(
      extractContextWindowFromConfig({ max_position_embeddings: 4096, sliding_window: 32768 }),
    ).toBe(32768);
  });

  it('extends window via text_config.sliding_window fallback', () => {
    const config = {
      text_config: { max_position_embeddings: 4096, sliding_window: 32768 },
    };
    expect(extractContextWindowFromConfig(config)).toBe(32768);
  });

  it('applies rope_scaling using original_max_position_embeddings * factor', () => {
    const config = {
      rope_scaling: { factor: 4.0, original_max_position_embeddings: 32768 },
    };
    expect(extractContextWindowFromConfig(config)).toBe(131072);
  });

  it('applies rope_scaling using text_config.rope_scaling when top-level rope data is absent', () => {
    const config = {
      text_config: {
        rope_scaling: { factor: 4.0, original_max_position_embeddings: 32768 },
      },
    };
    expect(extractContextWindowFromConfig(config)).toBe(131072);
  });

  it('falls back to README text patterns when config is null', () => {
    expect(
      extractContextWindowFromConfig(null, 'This model has context window: 128k tokens.'),
    ).toBe(128_000);
  });

  it('falls back to README when config has no usable signal', () => {
    expect(extractContextWindowFromConfig({}, 'supports 32k tokens of context')).toBe(32_000);
  });

  it('returns 0 when neither config nor README yield a signal', () => {
    expect(extractContextWindowFromConfig({}, 'no size info here')).toBe(0);
  });
});

describe('normalizeArchitectureFromConfig', () => {
  it('returns model_type verbatim when present', () => {
    expect(normalizeArchitectureFromConfig({ model_type: 'mistral3' })).toBe('mistral3');
  });

  it('classifies from architectures[0] when model_type is absent', () => {
    expect(
      normalizeArchitectureFromConfig({ architectures: ['Qwen2ForCausalLM'] }),
    ).toBe('qwen2');
  });

  it('classifies deepseek regardless of casing (Deepseek vs DeepSeek)', () => {
    expect(normalizeArchitectureFromConfig({ architectures: ['DeepseekV3ForCausalLM'] })).toBe(
      'deepseek',
    );
    expect(normalizeArchitectureFromConfig({ architectures: ['DeepSeekV2ForCausalLM'] })).toBe(
      'deepseek',
    );
  });

  it('classifies the extended family set (regression: agent-builder-baseline.ts previously lacked these)', () => {
    expect(normalizeArchitectureFromConfig({ architectures: ['FalconForCausalLM'] })).toBe(
      'falcon',
    );
    expect(normalizeArchitectureFromConfig({ architectures: ['GPTNeoXForCausalLM'] })).toBe(
      'gpt_neox',
    );
    expect(normalizeArchitectureFromConfig({ architectures: ['BloomForCausalLM'] })).toBe('bloom');
    expect(normalizeArchitectureFromConfig({ architectures: ['CohereForCausalLM'] })).toBe(
      'cohere',
    );
  });

  it('returns null when neither model_type nor a recognized architecture is present', () => {
    expect(normalizeArchitectureFromConfig({ architectures: ['SomeUnknownForCausalLM'] })).toBe(
      null,
    );
    expect(normalizeArchitectureFromConfig({})).toBe(null);
  });
});

describe('resolveEffectiveHfConfig', () => {
  it('returns the config unchanged when text_config is absent', () => {
    const config = { max_position_embeddings: 4096 };
    expect(resolveEffectiveHfConfig(config)).toEqual(config);
  });

  it('merges text_config fields over top-level fields', () => {
    const config = {
      model_type: 'mistral3',
      hidden_size: undefined,
      text_config: { hidden_size: 5120, num_hidden_layers: 40 },
    };
    const resolved = resolveEffectiveHfConfig(config);
    expect(resolved.hidden_size).toBe(5120);
    expect(resolved.num_hidden_layers).toBe(40);
  });

  it('prefers top-level quantization_config over text_config.quantization_config', () => {
    const config = {
      quantization_config: { quant_method: 'awq' },
      text_config: { quantization_config: { quant_method: 'gptq' } },
    };
    const resolved = resolveEffectiveHfConfig(config);
    expect((resolved.quantization_config as { quant_method: string }).quant_method).toBe('awq');
  });

  it('falls back to text_config.quantization_config when top-level is absent', () => {
    const config = {
      text_config: { quantization_config: { quant_method: 'gptq' } },
    };
    const resolved = resolveEffectiveHfConfig(config);
    expect((resolved.quantization_config as { quant_method: string }).quant_method).toBe('gptq');
  });
});
