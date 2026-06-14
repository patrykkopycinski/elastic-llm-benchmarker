import type { VMHardwareProfile } from '../types/config.js';
import type { HardwareProfileDefinition } from './hardware-profiles.js';

/**
 * Subset of HuggingFace config.json fields needed for memory estimation.
 */
export interface HFModelConfig {
  model_type?: string;
  architectures?: string[];
  max_position_embeddings?: number;
  quantization_config?: {
    quant_method?: string;
    bits?: number;
    [key: string]: unknown;
  };
  num_hidden_layers?: number;
  num_attention_heads?: number;
  hidden_size?: number;
  intermediate_size?: number;
  num_key_value_heads?: number;
  num_local_experts?: number;
  num_experts_per_tok?: number;
  num_parameters?: number;
  [key: string]: unknown;
}

/**
 * Result of GPU memory estimation for a model configuration.
 */
export interface EstimationResult {
  paramsBillions: number;
  weightsGb: number;
  kvCacheGb: number;
  activationGb: number;
  totalGb: number;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Result of a single dry-run fit check against a hardware profile.
 */
export interface DryRunResult {
  fits: boolean;
  estimatedGb: number;
  availableGb: number;
  reason: string;
}

/**
 * Result of evaluating a specific hardware profile for a model.
 */
export interface ProfileFitResult {
  profile: HardwareProfileDefinition;
  fits: boolean;
  estimatedGb: number;
  availableGb: number;
  reason: string;
}

/** Heuristic GPU VRAM capacity per device type in GB. */
const GPU_VRAM_GB: Record<string, number> = {
  'nvidia-l4': 24,
  'nvidia-a100-80gb': 80,
  'nvidia-a100-40gb': 40,
  'nvidia-t4': 16,
  'nvidia-v100': 32,
};

const DEFAULT_GPU_VRAM_GB = 24;
const GPU_MEMORY_UTILIZATION = 0.9;
const KV_SEQ_LEN = 8192;
const ACTIVATION_SEQ_LEN = 4096;
const BATCH_SIZE = 1;
const DEFAULT_DTYPE_BYTES = 2;

/**
 * Estimates GPU memory requirements for HuggingFace transformer models
 * and checks fit against hardware profiles.
 *
 * All public methods are guaranteed never to throw; on unexpected input
 * they return safe fallback values (low-confidence zero estimates or
 * `fits: false` with an explanatory reason).
 */
export class HardwareEstimator {
  /**
   * Estimate GPU memory breakdown for a model config.
   *
   * Returns weights, KV-cache, activation and total memory in GB.
   * Confidence reflects how complete the input config is.
   */
  estimateGpuMemory(config: HFModelConfig): EstimationResult {
    try {
      const { paramsBillions, confidence } = this.estimateParams(config);
      const dtypeBytes = this.estimateDtypeBytes(config);
      const weightsGb = (paramsBillions * 1_000_000_000 * dtypeBytes) / (1024 ** 3);

      const numLayers = config.num_hidden_layers ?? 0;
      const hiddenSize = config.hidden_size ?? 0;
      const numAttentionHeads = config.num_attention_heads || 1;
      const numKvHeads = config.num_key_value_heads ?? numAttentionHeads;

      let kvCacheGb = 0;
      let activationGb = 0;

      if (numLayers > 0 && hiddenSize > 0) {
        const headDim = hiddenSize / numAttentionHeads;
        kvCacheGb =
          (2 * numLayers * numKvHeads * headDim * KV_SEQ_LEN * dtypeBytes * BATCH_SIZE) /
          (1024 ** 3);
        activationGb =
          (2 * ACTIVATION_SEQ_LEN * hiddenSize * dtypeBytes * numLayers) / (1024 ** 3);
      }

      const totalGb = weightsGb + kvCacheGb + activationGb;

      // If quantization is present but we couldn't resolve a specific dtype,
      // downgrade confidence from high to medium.
      let finalConfidence = confidence;
      if (
        config.quantization_config &&
        dtypeBytes === DEFAULT_DTYPE_BYTES &&
        finalConfidence === 'high'
      ) {
        finalConfidence = 'medium';
      }

      return {
        paramsBillions: Math.round(paramsBillions * 100) / 100,
        weightsGb: Math.round(weightsGb * 100) / 100,
        kvCacheGb: Math.round(kvCacheGb * 100) / 100,
        activationGb: Math.round(activationGb * 100) / 100,
        totalGb: Math.round(totalGb * 100) / 100,
        confidence: finalConfidence,
      };
    } catch {
      // Zero human code fallback: never throw
      return {
        paramsBillions: 0,
        weightsGb: 0,
        kvCacheGb: 0,
        activationGb: 0,
        totalGb: 0,
        confidence: 'low',
      };
    }
  }

  /**
   * Check whether a model fits on a single hardware profile.
   */
  dryRunCheck(config: HFModelConfig, profile: VMHardwareProfile): DryRunResult {
    try {
      const estimation = this.estimateGpuMemory(config);
      const vramPerGpu = GPU_VRAM_GB[profile.gpuType] ?? DEFAULT_GPU_VRAM_GB;
      const totalVram = vramPerGpu * profile.gpuCount;
      const availableGb = totalVram * GPU_MEMORY_UTILIZATION;
      const fits = estimation.totalGb <= availableGb;

      let reason: string;
      if (fits) {
        reason = `Model estimated at ${estimation.totalGb} GB fits within available ${availableGb.toFixed(1)} GB (${profile.gpuCount}x ${profile.gpuType}, ${Math.round(GPU_MEMORY_UTILIZATION * 100)}% util)`;
      } else {
        const gap = estimation.totalGb - availableGb;
        reason = `Model estimated at ${estimation.totalGb} GB exceeds available ${availableGb.toFixed(1)} GB by ${gap.toFixed(1)} GB (${profile.gpuCount}x ${profile.gpuType})`;
      }

      return {
        fits,
        estimatedGb: estimation.totalGb,
        availableGb,
        reason,
      };
    } catch {
      return {
        fits: false,
        estimatedGb: 0,
        availableGb: 0,
        reason: 'Estimation failed for this profile',
      };
    }
  }

  /**
   * Evaluate fit across all profiles in a registry and return sorted results.
   *
   * Profiles where `fits=true` are listed first, followed by those that do not
   * fit. Within each group results are sorted by ascending available VRAM
   * (cheapest-first).
   */
  selectBestProfiles(
    config: HFModelConfig,
    registry: { listProfiles(): HardwareProfileDefinition[] },
  ): ProfileFitResult[] {
    try {
      const profiles = registry.listProfiles();
      const results: ProfileFitResult[] = profiles.map((profile) => {
        const check = this.dryRunCheck(config, profile.hardware);
        return {
          profile,
          fits: check.fits,
          estimatedGb: check.estimatedGb,
          availableGb: check.availableGb,
          reason: check.reason,
        };
      });

      // Sort: fits first, then by ascending available VRAM (cost proxy)
      results.sort((a, b) => {
        if (a.fits && !b.fits) return -1;
        if (!a.fits && b.fits) return 1;
        return a.availableGb - b.availableGb;
      });

      return results;
    } catch {
      return [];
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private estimateParams(config: HFModelConfig): {
    paramsBillions: number;
    confidence: 'high' | 'medium' | 'low';
  } {
    const hiddenSize = config.hidden_size;
    const numLayers = config.num_hidden_layers;
    const numAttentionHeads = config.num_attention_heads;
    const numKvHeads = config.num_key_value_heads;
    const numLocalExperts = config.num_local_experts;

    // If explicit parameter count is provided, use it directly.
    const explicitParams = config.num_parameters;
    if (typeof explicitParams === 'number' && explicitParams > 0) {
      const billions =
        explicitParams > 1_000_000_000 ? explicitParams / 1_000_000_000 : explicitParams;
      return { paramsBillions: billions, confidence: 'high' };
    }

    const hasAllMajor =
      typeof hiddenSize === 'number' &&
      hiddenSize > 0 &&
      typeof numLayers === 'number' &&
      numLayers > 0 &&
      typeof numAttentionHeads === 'number' &&
      numAttentionHeads > 0;

    if (!hasAllMajor) {
      return { paramsBillions: 0, confidence: 'low' };
    }

    // Rough heuristic: hidden_size^2 * 12 * num_layers / 1e9
    let paramsBillions = ((hiddenSize ** 2) * 12 * numLayers) / 1e9;

    // MoE adjustment: if both GQA/MQA heads and local experts are present,
    // scale up by the expert count factor.
    if (
      typeof numKvHeads === 'number' &&
      numKvHeads > 0 &&
      typeof numLocalExperts === 'number' &&
      numLocalExperts > 1
    ) {
      paramsBillions *= Math.max(1, numLocalExperts * 0.9);
    }

    // Confidence drops to medium if intermediate_size is missing (heuristic is rougher)
    const confidence =
      typeof config.intermediate_size === 'number' && config.intermediate_size > 0
        ? 'high'
        : 'medium';
    return { paramsBillions, confidence };
  }

  private estimateDtypeBytes(config: HFModelConfig): number {
    const qc = config.quantization_config;
    if (qc && typeof qc === 'object') {
      if (typeof qc.bits === 'number') {
        return qc.bits / 8;
      }

      const method = String(qc.quant_method ?? '').toLowerCase();

      if (
        method.includes('q4') ||
        method.includes('int4') ||
        method.includes('4bit') ||
        method === '4'
      ) {
        return 0.5;
      }

      if (
        method.includes('q8') ||
        method.includes('int8') ||
        method.includes('8bit') ||
        method === '8'
      ) {
        return 1.0;
      }

      if (method.includes('fp8')) {
        return 1.0;
      }

      if (method.includes('fp16') || method.includes('bf16')) {
        return 2.0;
      }
    }

    return DEFAULT_DTYPE_BYTES;
  }
}
