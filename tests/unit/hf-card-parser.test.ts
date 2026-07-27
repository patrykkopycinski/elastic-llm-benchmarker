import { describe, it, expect } from 'vitest';
import {
  estimateParamsBillionsFromConfig,
  extractContextWindowFromConfig,
} from '../../src/services/hf-card-parser.js';

describe('extractContextWindowFromConfig', () => {
  it('reads max_position_embeddings from top-level config', () => {
    expect(extractContextWindowFromConfig({ max_position_embeddings: 131072 }, '')).toBe(131072);
  });

  it('falls back to text_config.max_position_embeddings for VLM-wrapped configs (regression: Mistral-Small-3.2-24B-Instruct-2506 / Qwen3.6-35B-A3B-FP8-style configs nest real text-model dims under text_config while top-level fields are undefined for the multimodal wrapper — this used to return 0 for a real 262144-token model)', () => {
    const config = {
      model_type: 'mistral3',
      text_config: {
        max_position_embeddings: 262144,
      },
    };
    expect(extractContextWindowFromConfig(config, '')).toBe(262144);
  });

  it('prefers top-level max_position_embeddings over text_config when both are present', () => {
    const config = {
      max_position_embeddings: 4096,
      text_config: { max_position_embeddings: 262144 },
    };
    expect(extractContextWindowFromConfig(config, '')).toBe(4096);
  });

  it('applies rope_scaling using text_config.original_max_position_embeddings when top-level rope data is absent', () => {
    const config = {
      text_config: {
        rope_scaling: { factor: 4.0, original_max_position_embeddings: 32768 },
      },
    };
    expect(extractContextWindowFromConfig(config, '')).toBe(131072);
  });

  it('falls back to README text patterns when config is null', () => {
    expect(
      extractContextWindowFromConfig(null, 'This model has context window: 128k tokens.'),
    ).toBe(128_000);
  });

  it('returns 0 when neither config nor README yield a signal', () => {
    expect(extractContextWindowFromConfig({}, 'no size info here')).toBe(0);
  });
});

describe('estimateParamsBillionsFromConfig', () => {
  it('returns null when shape fields are missing', () => {
    expect(estimateParamsBillionsFromConfig(null)).toBeNull();
    expect(estimateParamsBillionsFromConfig({})).toBeNull();
    expect(estimateParamsBillionsFromConfig({ hidden_size: 4096 })).toBeNull();
    expect(estimateParamsBillionsFromConfig({ num_hidden_layers: 32 })).toBeNull();
  });

  it('estimates a dense 7B-class model within tolerance (Mistral-7B shape)', () => {
    // Mistral-7B-Instruct-v0.2 config shape.
    const est = estimateParamsBillionsFromConfig({
      hidden_size: 4096,
      num_hidden_layers: 32,
      intermediate_size: 14336,
      vocab_size: 32000,
    });
    expect(est).not.toBeNull();
    expect(est).toBeGreaterThan(6.5);
    expect(est).toBeLessThan(8);
  });

  it('estimates a dense 24B-class model within tolerance (Mistral-Small-24B shape)', () => {
    // Mistral-Small-24B-Instruct-2501 config shape.
    const est = estimateParamsBillionsFromConfig({
      hidden_size: 5120,
      num_hidden_layers: 40,
      intermediate_size: 32768,
      vocab_size: 131072,
    });
    expect(est).not.toBeNull();
    expect(est).toBeGreaterThan(20);
    expect(est).toBeLessThan(28);
  });

  it('reports MoE TOTAL params for a sparse model, not the dense-equivalent (Qwen3-30B-A3B shape)', () => {
    // Qwen3-Coder-30B-A3B: 128 routed experts, per-expert FFN width 768.
    const cfg = {
      hidden_size: 2048,
      num_hidden_layers: 48,
      intermediate_size: 768,
      moe_intermediate_size: 768,
      num_experts: 128,
      vocab_size: 151936,
    };
    const est = estimateParamsBillionsFromConfig(cfg);
    expect(est).not.toBeNull();
    // ~30B total; the naive dense formula would have returned ~2-3B.
    expect(est).toBeGreaterThan(24);
    expect(est).toBeLessThan(36);

    // Confirm the dense-equivalent (experts stripped) is far below the 24B floor,
    // i.e. the MoE-awareness is what carries it over the baseline.
    const denseEquivalent = estimateParamsBillionsFromConfig({
      hidden_size: 2048,
      num_hidden_layers: 48,
      intermediate_size: 768,
      vocab_size: 151936,
    });
    expect(denseEquivalent).not.toBeNull();
    expect(denseEquivalent as number).toBeLessThan(5);
  });

  it('handles Mixtral-style experts that reuse intermediate_size (Mixtral-8x7B shape)', () => {
    // Mixtral-8x7B: 8 experts, no moe_intermediate_size → expert width = intermediate_size.
    const est = estimateParamsBillionsFromConfig({
      hidden_size: 4096,
      num_hidden_layers: 32,
      intermediate_size: 14336,
      num_local_experts: 8,
      vocab_size: 32000,
    });
    expect(est).not.toBeNull();
    // Mixtral-8x7B is ~46.7B total.
    expect(est).toBeGreaterThan(40);
    expect(est).toBeLessThan(52);
  });

  it('adds DeepSeek-style shared experts on top of routed experts', () => {
    const routedOnly = estimateParamsBillionsFromConfig({
      hidden_size: 2048,
      num_hidden_layers: 27,
      moe_intermediate_size: 1408,
      n_routed_experts: 64,
      vocab_size: 102400,
    });
    const withShared = estimateParamsBillionsFromConfig({
      hidden_size: 2048,
      num_hidden_layers: 27,
      moe_intermediate_size: 1408,
      n_routed_experts: 64,
      n_shared_experts: 2,
      vocab_size: 102400,
    });
    expect(routedOnly).not.toBeNull();
    expect(withShared).not.toBeNull();
    expect(withShared as number).toBeGreaterThan(routedOnly as number);
  });
});
