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
