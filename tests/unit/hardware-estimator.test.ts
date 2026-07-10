import { describe, it, expect } from 'vitest';
import { HardwareEstimator } from '../../src/services/hardware-estimator.js';
import { HardwareProfileRegistry } from '../../src/services/hardware-profiles.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestRegistry(): HardwareProfileRegistry {
  const registry = new HardwareProfileRegistry();
  // Clear built-ins and register minimal test profiles
  (registry as unknown as { profiles: Map<string, unknown> }).profiles.clear();
  registry.registerProfile({
    id: '1xl4',
    displayName: '1x NVIDIA L4',
    description: 'Small profile',
    hardware: {
      gpuType: 'nvidia-l4',
      gpuCount: 1,
      ramGb: 64,
      cpuCores: 8,
      diskGb: 200,
      machineType: 'g2-standard-8',
    },
  });
  registry.registerProfile({
    id: '1xa100-80gb',
    displayName: '1x NVIDIA A100 80GB',
    description: 'Large profile',
    hardware: {
      gpuType: 'nvidia-a100-80gb',
      gpuCount: 1,
      ramGb: 340,
      cpuCores: 12,
      diskGb: 500,
      machineType: 'a2-highgpu-1g',
    },
  });
  return registry;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('HardwareEstimator', () => {
  const estimator = new HardwareEstimator();

  describe('estimateGpuMemory', () => {
    it('estimates a Llama 7B-like dense model', () => {
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 32,
      };
      const result = estimator.estimateGpuMemory(config);

      expect(result.paramsBillions).toBe(6.44);
      expect(result.weightsGb).toBe(12);
      expect(result.kvCacheGb).toBe(4);
      expect(result.activationGb).toBe(2);
      expect(result.totalGb).toBe(18);
      expect(result.confidence).toBe('medium');
    });

    it('estimates a dense model with all fields → high confidence', () => {
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 32,
        intermediate_size: 11008,
      };
      const result = estimator.estimateGpuMemory(config);
      expect(result.confidence).toBe('high');
    });

    it('estimates an MoE model with higher memory due to experts', () => {
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 8,
        num_local_experts: 8,
        num_experts_per_tok: 2,
      };
      const result = estimator.estimateGpuMemory(config);

      expect(result.paramsBillions).toBe(46.39);
      expect(result.weightsGb).toBe(86.4);
      expect(result.kvCacheGb).toBe(1);
      expect(result.activationGb).toBe(2);
      expect(result.totalGb).toBe(89.4);
      expect(result.confidence).toBe('medium');
    });

    it('estimates a DeepSeek-V3/Kimi-K2-style MoE model using n_routed_experts naming', () => {
      // Regression: moonshotai/Kimi-K2-Instruct-0905 (~1T total params) only
      // declares `n_routed_experts` (DeepSeek-V3 naming), not `num_local_experts`
      // (Mixtral naming). Before this fix the MoE multiplier never fired, so
      // the estimator reported it as a ~37B dense model — hardwareFit: true on
      // a 2xA100-80GB profile that would actually OOM on deploy.
      const denseConfig = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 8,
      };
      const moeConfig = {
        ...denseConfig,
        n_routed_experts: 8,
        num_experts_per_tok: 2,
      };

      const denseResult = estimator.estimateGpuMemory(denseConfig);
      const moeResult = estimator.estimateGpuMemory(moeConfig);

      expect(moeResult.paramsBillions).toBeGreaterThan(denseResult.paramsBillions * 5);
    });

    it('estimates a Qwen3-MoE-style model using num_experts naming', () => {
      const denseConfig = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 8,
      };
      const moeConfig = {
        ...denseConfig,
        num_experts: 8,
        num_experts_per_tok: 2,
      };

      const denseResult = estimator.estimateGpuMemory(denseConfig);
      const moeResult = estimator.estimateGpuMemory(moeConfig);

      expect(moeResult.paramsBillions).toBeGreaterThan(denseResult.paramsBillions * 5);
    });

    it('estimates a high-expert-count MoE with moe_intermediate_size precisely (GLM-4.5-Air)', () => {
      // Regression: the naive `numExperts * 0.9` multiplier (used when
      // moe_intermediate_size is absent) scales the ENTIRE dense-equivalent
      // estimate — including the wide dense-FFN term baked into the 12h^2
      // heuristic — by the full expert count. For high-expert-count
      // DeepSeek-V3-style architectures (128+ experts) that overshoots by
      // ~10-20x, because real MoE experts use a much narrower
      // `moe_intermediate_size`, not the dense-equivalent width. Real
      // zai-org/GLM-4.5-Air config: 128 routed experts, 1 shared expert,
      // moe_intermediate_size 1408, ~106B published total params. The old
      // formula estimated ~1990GB (would reject a model that fits on
      // 2xA100-80GB with FP8); this formula lands within ~1% of 106B params.
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 46,
        num_attention_heads: 96,
        num_key_value_heads: 8,
        n_routed_experts: 128,
        n_shared_experts: 1,
        moe_intermediate_size: 1408,
        num_experts_per_tok: 8,
      };
      const result = estimator.estimateGpuMemory(config);

      expect(result.paramsBillions).toBeGreaterThan(95);
      expect(result.paramsBillions).toBeLessThan(115);
    });

    it('estimates a very-high-expert-count MoE precisely (Kimi-K2)', () => {
      // Real moonshotai/Kimi-K2-Instruct-0905 config: 384 routed experts,
      // 1 shared expert, moe_intermediate_size 2048, ~1T published total
      // params. The old whole-model multiplier estimated ~12,115GB (12x
      // over); this formula lands within ~5% of 1T params.
      const config = {
        hidden_size: 7168,
        num_hidden_layers: 61,
        num_attention_heads: 64,
        num_key_value_heads: 64,
        n_routed_experts: 384,
        n_shared_experts: 1,
        moe_intermediate_size: 2048,
        num_experts_per_tok: 8,
      };
      const result = estimator.estimateGpuMemory(config);

      expect(result.paramsBillions).toBeGreaterThan(950);
      expect(result.paramsBillions).toBeLessThan(1100);
    });

    it('returns low confidence and zero for missing major fields', () => {
      const result = estimator.estimateGpuMemory({});

      expect(result.paramsBillions).toBe(0);
      expect(result.weightsGb).toBe(0);
      expect(result.kvCacheGb).toBe(0);
      expect(result.activationGb).toBe(0);
      expect(result.totalGb).toBe(0);
      expect(result.confidence).toBe('low');
    });

    it('reduces memory with 4-bit quantization', () => {
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 32,
        quantization_config: {
          quant_method: 'q4_K_M',
        },
      };
      const result = estimator.estimateGpuMemory(config);

      expect(result.weightsGb).toBe(3);
      expect(result.kvCacheGb).toBe(1);
      expect(result.activationGb).toBe(0.5);
      expect(result.totalGb).toBe(4.5);
    });

    it('uses bits field when present', () => {
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 32,
        quantization_config: {
          bits: 8,
        },
      };
      const result = estimator.estimateGpuMemory(config);

      // 8 bits = 1 byte per param → half the fp16 weights
      expect(result.weightsGb).toBe(6);
      expect(result.totalGb).toBe(9);
    });

    it('parses compressed-tensors FP8 quantization from nested config_groups (GLM-4.5-Air-FP8)', () => {
      // Regression: zai-org/GLM-4.5-Air-FP8 uses HF's "compressed-tensors"
      // format, where quant_method is literally "compressed-tensors" (matches
      // no keyword substring check) and the real bit-width lives nested at
      // quantization_config.config_groups.group_0.weights.num_bits. Before
      // this fix, estimateDtypeBytes fell through to DEFAULT_DTYPE_BYTES (2
      // bytes = BF16), overestimating VRAM ~2x and producing a false
      // "doesn't fit" hardware-fit rejection during discovery. Verified
      // against the live HF config.json (fetched 2026-07-10).
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 32,
        quantization_config: {
          quant_method: 'compressed-tensors',
          format: 'float-quantized',
          config_groups: {
            group_0: {
              weights: { num_bits: 8, type: 'float' },
              input_activations: { num_bits: 8, type: 'float' },
            },
          },
        },
      };
      const result = estimator.estimateGpuMemory(config);

      // 8 bits = 1 byte per param → half the fp16 weights, same as `bits: 8`
      expect(result.weightsGb).toBe(6);
      expect(result.totalGb).toBe(9);
    });

    it('parses compressed-tensors NVFP4 quantization from nested config_groups (GLM-4.5-Air-nvfp4)', () => {
      // Regression: Firworks/GLM-4.5-Air-nvfp4 — same compressed-tensors
      // shape, but num_bits: 4 nested under config_groups.group_0.weights.
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 32,
        quantization_config: {
          quant_method: 'compressed-tensors',
          format: 'nvfp4-pack-quantized',
          config_groups: {
            group_0: {
              format: 'nvfp4-pack-quantized',
              weights: { num_bits: 4, type: 'float' },
              input_activations: { num_bits: 4, type: 'float' },
            },
          },
        },
      };
      const result = estimator.estimateGpuMemory(config);

      // 4 bits = 0.5 bytes per param → quarter the fp16 weights
      expect(result.weightsGb).toBe(3);
      expect(result.totalGb).toBe(4.5);
    });

    it('downgrades confidence for unknown quantization', () => {
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 32,
        intermediate_size: 11008,
        quantization_config: {
          quant_method: 'custom_unknown',
        },
      };
      const result = estimator.estimateGpuMemory(config);
      expect(result.confidence).toBe('medium');
    });

    it('uses explicit num_parameters when provided', () => {
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_parameters: 7_000_000_000,
      };
      const result = estimator.estimateGpuMemory(config);
      expect(result.paramsBillions).toBe(7);
      expect(result.confidence).toBe('high');
    });
  });

  describe('dryRunCheck', () => {
    it('reports fit when model fits on the profile', () => {
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 32,
      };
      const profile = {
        gpuType: 'nvidia-l4',
        gpuCount: 1,
        ramGb: 64,
        cpuCores: 8,
        diskGb: 200,
        machineType: 'g2-standard-8',
      };

      const result = estimator.dryRunCheck(config, profile);

      expect(result.fits).toBe(true);
      expect(result.estimatedGb).toBe(18);
      expect(result.availableGb).toBeCloseTo(22.8, 1); // 24 * 0.95
      expect(result.reason).toContain('fits within available');
    });

    it('reports no-fit when model exceeds profile capacity', () => {
      const config = {
        hidden_size: 5120,
        num_hidden_layers: 40,
        num_attention_heads: 40,
        num_key_value_heads: 40,
      };
      const profile = {
        gpuType: 'nvidia-l4',
        gpuCount: 1,
        ramGb: 64,
        cpuCores: 8,
        diskGb: 200,
        machineType: 'g2-standard-8',
      };

      const result = estimator.dryRunCheck(config, profile);

      expect(result.fits).toBe(false);
      expect(result.estimatedGb).toBe(32.81);
      expect(result.availableGb).toBeCloseTo(22.8, 1);
      expect(result.reason).toContain('exceeds available');
    });

    it('defaults to 24 GB for unknown GPU types', () => {
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 32,
      };
      const profile = {
        gpuType: 'nvidia-rtx-4090',
        gpuCount: 1,
        ramGb: 64,
        cpuCores: 8,
        diskGb: 200,
        machineType: 'custom',
      };

      const result = estimator.dryRunCheck(config, profile);
      expect(result.availableGb).toBeCloseTo(22.8, 1); // 24 * 0.95
    });
  });

  describe('selectBestProfiles', () => {
    it('returns fits=true profiles first, sorted by ascending available VRAM', () => {
      const registry = createTestRegistry();
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 32,
      };

      const results = estimator.selectBestProfiles(config, registry);

      expect(results).toHaveLength(2);
      expect(results[0].profile.id).toBe('1xl4');
      expect(results[0].fits).toBe(true);
      expect(results[1].profile.id).toBe('1xa100-80gb');
      expect(results[1].fits).toBe(true);
      // Both fit, sorted by available VRAM ascending
      expect(results[0].availableGb).toBeLessThan(results[1].availableGb);
    });

    it('places non-fitting profiles after fitting ones', () => {
      const registry = createTestRegistry();
      const config = {
        hidden_size: 5120,
        num_hidden_layers: 40,
        num_attention_heads: 40,
        num_key_value_heads: 40,
      };

      const results = estimator.selectBestProfiles(config, registry);

      expect(results).toHaveLength(2);
      expect(results[0].profile.id).toBe('1xa100-80gb');
      expect(results[0].fits).toBe(true);
      expect(results[1].profile.id).toBe('1xl4');
      expect(results[1].fits).toBe(false);
    });

    it('handles empty registry gracefully', () => {
      const registry = new HardwareProfileRegistry();
      (registry as unknown as { profiles: Map<string, unknown> }).profiles.clear();

      const results = estimator.selectBestProfiles({ hidden_size: 4096 }, registry);
      expect(results).toHaveLength(0);
    });
  });

  describe('safety / never throws', () => {
    it('survives garbage config objects', () => {
      const garbage = {
        hidden_size: -1,
        num_hidden_layers: -1,
        num_attention_heads: -1,
      };
      const result = estimator.estimateGpuMemory(garbage);
      expect(result.confidence).toBe('low');
      expect(result.totalGb).toBe(0);
    });

    it('survives null-like values in optional fields', () => {
      const config = {
        hidden_size: 4096,
        num_hidden_layers: 32,
        num_attention_heads: 32,
        num_key_value_heads: 0,
        num_local_experts: 0,
        intermediate_size: 0,
      };
      const result = estimator.estimateGpuMemory(config);
      expect(result.confidence).toBe('medium'); // intermediate_size is 0, falls back to medium
      expect(result.totalGb).toBeGreaterThan(0);
    });
  });
});
