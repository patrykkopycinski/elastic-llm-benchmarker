import { describe, it, expect } from 'vitest';
import { ModelCandidateFilter } from '../../src/services/model-candidate-filter.js';
import type { ModelInfo } from '../../src/types/benchmark.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/**
 * Creates a valid model candidate that passes all default filters.
 * Override individual fields to test specific filter criteria.
 */
function createModelCandidate(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'test-org/test-model-instruct',
    name: 'test-model-instruct',
    architecture: 'llama',
    contextWindow: 131072,
    license: 'apache-2.0',
    parameterCount: 70_000_000_000,
    quantizations: ['fp16'],
    supportsToolCalling: true,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ModelCandidateFilter', () => {
  describe('constructor', () => {
    it('should initialize with default options', () => {
      const filter = new ModelCandidateFilter('error');
      expect(filter).toBeDefined();
      expect(filter.getTotalVramGb()).toBe(160); // 2x A100 80GB default
    });

    it('should accept custom options', () => {
      const filter = new ModelCandidateFilter('error', {
        minContextWindow: 64000,
        targetHardwareProfile: {
          gpuType: 'nvidia-a100-80gb',
          gpuCount: 4,
          ramGb: 1360,
          cpuCores: 48,
          diskGb: 2000,
          machineType: 'a2-ultragpu-4g',
        },
        requireToolCalling: false,
      });
      expect(filter.getTotalVramGb()).toBe(320); // 4x A100 80GB
    });
  });

  describe('evaluate - passing model', () => {
    it('should pass a model that meets all criteria', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate();
      const result = filter.evaluate(model);

      expect(result.passed).toBe(true);
      expect(result.rejections).toHaveLength(0);
      expect(result.model).toBe(model);
    });

    it('should return recommended tool call parser for passing models', () => {
      const filter = new ModelCandidateFilter('error');

      const llamaModel = createModelCandidate({ architecture: 'llama' });
      expect(filter.evaluate(llamaModel).recommendedToolCallParser).toBe('llama3_json');

      const qwenModel = createModelCandidate({ architecture: 'qwen2' });
      expect(filter.evaluate(qwenModel).recommendedToolCallParser).toBe('hermes');

      const mistralModel = createModelCandidate({ architecture: 'mistral' });
      expect(filter.evaluate(mistralModel).recommendedToolCallParser).toBe('mistral');
    });

    it('should return estimated VRAM for passing models', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        parameterCount: 70_000_000_000,
        quantizations: ['fp16'],
      });
      const result = filter.evaluate(model);

      // 70B * 2 bytes / (1024^3) * 1.2 overhead ≈ 156.2 GB
      expect(result.estimatedVramGb).toBeGreaterThan(0);
      expect(result.estimatedVramGb).not.toBeNull();
    });
  });

  describe('context size filter', () => {
    it('should reject models with context window below 128K', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({ contextWindow: 4096 });
      const result = filter.evaluate(model);

      expect(result.passed).toBe(false);
      expect(result.rejections.some((r) => r.criterion === 'context_size')).toBe(true);
      expect(result.rejections.find((r) => r.criterion === 'context_size')!.isHardRequirement).toBe(
        true,
      );
    });

    it('should accept models with exactly 128K context window', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({ contextWindow: 128000 });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'context_size')).toBe(false);
    });

    it('should accept models with context window above 128K', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({ contextWindow: 200000 });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'context_size')).toBe(false);
    });

    it('should use custom minimum context window when provided', () => {
      const filter = new ModelCandidateFilter('error', { minContextWindow: 64000 });
      const model = createModelCandidate({ contextWindow: 65000 });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'context_size')).toBe(false);
    });

    it('should reject context window of 0', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({ contextWindow: 0 });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'context_size')).toBe(true);
    });
  });

  describe('model size filter (VRAM fit)', () => {
    it('should reject models that exceed 2x A100 80GB VRAM (160GB)', () => {
      const filter = new ModelCandidateFilter('error');
      // 180B fp16 = ~335GB, way over 160GB
      const model = createModelCandidate({
        parameterCount: 180_000_000_000,
        quantizations: ['fp16'],
      });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'model_size')).toBe(true);
    });

    it('should accept models that fit within 2x A100 80GB VRAM', () => {
      const filter = new ModelCandidateFilter('error');
      // 7B fp16 = ~13GB, well within 160GB
      const model = createModelCandidate({
        parameterCount: 7_000_000_000,
        quantizations: ['fp16'],
      });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'model_size')).toBe(false);
    });

    it('should consider quantization when estimating VRAM', () => {
      const filter = new ModelCandidateFilter('error');
      // 70B with int4 quantization: ~70B * 0.5 bytes / (1024^3) * 1.2 ≈ 39GB
      const model = createModelCandidate({
        parameterCount: 70_000_000_000,
        quantizations: ['gptq', 'gptq-4bit'],
      });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'model_size')).toBe(false);
      expect(result.estimatedVramGb!).toBeLessThan(50);
    });

    it('should issue warning (not rejection) when parameter count is unknown', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({ parameterCount: null });
      const result = filter.evaluate(model);

      // Should not be a hard rejection
      expect(result.rejections.some((r) => r.criterion === 'model_size')).toBe(false);
      // Should be a warning
      expect(result.warnings.some((r) => r.criterion === 'model_size')).toBe(true);
    });

    it('should use custom target hardware profile for VRAM calculation', () => {
      const filter = new ModelCandidateFilter('error', {
        targetHardwareProfile: {
          gpuType: 'nvidia-l4',
          gpuCount: 1,
          ramGb: 64,
          cpuCores: 8,
          diskGb: 200,
          machineType: 'g2-standard-8',
        },
      });
      // 24GB VRAM (1x L4), so 70B fp16 (~156GB) should fail
      const model = createModelCandidate({
        parameterCount: 70_000_000_000,
        quantizations: ['fp16'],
      });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'model_size')).toBe(true);
    });

    it('should return null estimated VRAM when parameter count is null', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({ parameterCount: null });
      const result = filter.evaluate(model);

      expect(result.estimatedVramGb).toBeNull();
    });
  });

  describe('vLLM architecture filter', () => {
    const supportedArchitectures = [
      'llama',
      'mistral',
      'mixtral',
      'qwen',
      'qwen2',
      'qwen2_moe',
      'gemma',
      'phi',
      'deepseek',
      'falcon',
      'yi',
      'codellama',
      'command-r',
    ];

    for (const arch of supportedArchitectures) {
      it(`should accept supported vLLM architecture: ${arch}`, () => {
        const filter = new ModelCandidateFilter('error', { requireToolCalling: false });
        const model = createModelCandidate({ architecture: arch });
        const result = filter.evaluate(model);

        expect(result.rejections.some((r) => r.criterion === 'vllm_architecture')).toBe(false);
      });
    }

    it('should reject unsupported architectures', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({ architecture: 'vit' });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'vllm_architecture')).toBe(true);
    });

    it('should reject architecture "unknown"', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({ architecture: 'unknown' });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'vllm_architecture')).toBe(true);
    });

    it('should handle partial architecture matches', () => {
      const filter = new ModelCandidateFilter('error', { requireToolCalling: false });
      // "deepseek_v2" should match because it contains "deepseek"
      const model = createModelCandidate({ architecture: 'deepseek_v2' });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'vllm_architecture')).toBe(false);
    });
  });

  describe('tool calling filter', () => {
    it('should reject models without tool calling support', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({ supportsToolCalling: false });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(true);
    });

    it('should reject models with tool calling but no known parser', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        architecture: 'falcon',
        supportsToolCalling: true,
        id: 'tiiuae/falcon-40b-instruct',
      });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(true);
      expect(result.rejections.find((r) => r.criterion === 'tool_calling')!.reason).toContain(
        'No known vLLM tool call parser',
      );
    });

    it('should accept Qwen models with hermes parser', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        architecture: 'qwen2',
        supportsToolCalling: true,
      });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(false);
      expect(result.recommendedToolCallParser).toBe('hermes');
    });

    it('should accept Mistral models with mistral parser', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        architecture: 'mistral',
        supportsToolCalling: true,
      });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(false);
      expect(result.recommendedToolCallParser).toBe('mistral');
    });

    it('should accept Llama models with llama3_json parser', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        architecture: 'llama',
        supportsToolCalling: true,
      });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(false);
      expect(result.recommendedToolCallParser).toBe('llama3_json');
    });

    it('should not reject when requireToolCalling is false', () => {
      const filter = new ModelCandidateFilter('error', { requireToolCalling: false });
      const model = createModelCandidate({
        supportsToolCalling: false,
        architecture: 'llama',
      });
      const result = filter.evaluate(model);

      // Should be a warning, not a rejection
      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(false);
      expect(result.warnings.some((r) => r.criterion === 'tool_calling')).toBe(true);
    });

    it('should detect parser from model ID when architecture does not match', () => {
      const filter = new ModelCandidateFilter('error', { requireToolCalling: false });

      // Model ID contains "qwen" even though architecture is generic
      const model = createModelCandidate({
        id: 'Qwen/Qwen2.5-72B-Instruct',
        architecture: 'qwen2',
      });
      const result = filter.evaluate(model);

      expect(result.recommendedToolCallParser).toBe('hermes');
    });
  });

  describe('known failure list', () => {
    it('should reject models in the exact known failure list', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        id: 'tiiuae/falcon-180B',
        architecture: 'falcon',
        supportsToolCalling: true,
      });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'known_failure')).toBe(true);
      expect(result.rejections.find((r) => r.criterion === 'known_failure')!.reason).toContain(
        'known failure list',
      );
    });

    it('should reject models matching wildcard patterns in failure list', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        id: 'stabilityai/stablelm-2-12b-chat',
        architecture: 'stablelm',
        supportsToolCalling: true,
      });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'known_failure')).toBe(true);
    });

    it('should not reject models not in the known failure list', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        id: 'meta-llama/Llama-3.1-70B-Instruct',
      });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'known_failure')).toBe(false);
    });

    it('should skip known failure check when disabled', () => {
      const filter = new ModelCandidateFilter('error', { checkKnownFailures: false });
      const model = createModelCandidate({
        id: 'tiiuae/falcon-180B',
        architecture: 'falcon',
        supportsToolCalling: true,
      });
      const result = filter.evaluate(model);

      expect(result.rejections.some((r) => r.criterion === 'known_failure')).toBe(false);
    });
  });

  describe('evaluateBatch', () => {
    it('should partition models into passed and rejected', () => {
      const filter = new ModelCandidateFilter('error');
      const models = [
        createModelCandidate({ id: 'org/good-model-1' }),
        createModelCandidate({ id: 'org/small-ctx', contextWindow: 4096 }),
        createModelCandidate({ id: 'org/good-model-2' }),
        createModelCandidate({ id: 'org/bad-arch', architecture: 'vit' }),
      ];

      const result = filter.evaluateBatch(models);

      expect(result.passed).toHaveLength(2);
      expect(result.rejected).toHaveLength(2);
      expect(result.totalEvaluated).toBe(4);
      expect(result.timestamp).toBeTruthy();
    });

    it('should handle empty batch', () => {
      const filter = new ModelCandidateFilter('error');
      const result = filter.evaluateBatch([]);

      expect(result.passed).toHaveLength(0);
      expect(result.rejected).toHaveLength(0);
      expect(result.totalEvaluated).toBe(0);
    });

    it('should handle all models passing', () => {
      const filter = new ModelCandidateFilter('error');
      const models = [
        createModelCandidate({ id: 'org/model-1' }),
        createModelCandidate({ id: 'org/model-2' }),
      ];

      const result = filter.evaluateBatch(models);

      expect(result.passed).toHaveLength(2);
      expect(result.rejected).toHaveLength(0);
    });

    it('should handle all models rejected', () => {
      const filter = new ModelCandidateFilter('error');
      const models = [
        createModelCandidate({ id: 'org/bad-1', contextWindow: 100 }),
        createModelCandidate({ id: 'org/bad-2', architecture: 'vit' }),
      ];

      const result = filter.evaluateBatch(models);

      expect(result.passed).toHaveLength(0);
      expect(result.rejected).toHaveLength(2);
    });
  });

  describe('getRecommendedToolCallParser', () => {
    it('should return hermes for qwen models', () => {
      const filter = new ModelCandidateFilter('error');
      expect(
        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'qwen' })),
      ).toBe('hermes');
      expect(
        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'qwen2' })),
      ).toBe('hermes');
      expect(
        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'qwen2_moe' })),
      ).toBe('hermes');
    });

    it('should return mistral for mistral/mixtral models', () => {
      const filter = new ModelCandidateFilter('error');
      expect(
        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'mistral' })),
      ).toBe('mistral');
      expect(
        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'mixtral' })),
      ).toBe('mistral');
    });

    it('should return llama3_json for llama models', () => {
      const filter = new ModelCandidateFilter('error');
      expect(
        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'llama' })),
      ).toBe('llama3_json');
      expect(
        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'codellama' })),
      ).toBe('llama3_json');
    });

    it('should return null for architectures without known parser', () => {
      const filter = new ModelCandidateFilter('error');
      expect(
        filter.getRecommendedToolCallParser(
          createModelCandidate({ architecture: 'falcon', id: 'tiiuae/falcon-40b' }),
        ),
      ).toBeNull();
    });

    it('should detect parser from model ID as fallback', () => {
      const filter = new ModelCandidateFilter('error');
      // Architecture is gemma (no parser) but model ID has llama in it
      expect(
        filter.getRecommendedToolCallParser(
          createModelCandidate({
            architecture: 'gemma',
            id: 'org/llama-derived-model',
          }),
        ),
      ).toBe('llama3_json');
    });
  });

  describe('estimateVramUsage', () => {
    it('should estimate VRAM for fp16 model', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        parameterCount: 7_000_000_000,
        quantizations: ['fp16'],
      });

      const vram = filter.estimateVramUsage(model);

      // 7B * 2 bytes / (1024^3) * 1.2 ≈ 15.6 GB
      expect(vram).not.toBeNull();
      expect(vram!).toBeGreaterThan(10);
      expect(vram!).toBeLessThan(25);
    });

    it('should estimate lower VRAM for quantized models', () => {
      const filter = new ModelCandidateFilter('error');
      const fp16Model = createModelCandidate({
        parameterCount: 70_000_000_000,
        quantizations: ['fp16'],
      });
      const quantModel = createModelCandidate({
        parameterCount: 70_000_000_000,
        quantizations: ['gptq', 'gptq-4bit'],
      });

      const fp16Vram = filter.estimateVramUsage(fp16Model)!;
      const quantVram = filter.estimateVramUsage(quantModel)!;

      expect(quantVram).toBeLessThan(fp16Vram);
    });

    it('should return null when parameter count is null', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({ parameterCount: null });

      expect(filter.estimateVramUsage(model)).toBeNull();
    });

    it('should use best available quantization for estimation', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        parameterCount: 70_000_000_000,
        quantizations: ['fp16', 'awq', 'gptq-4bit'],
      });

      const vram = filter.estimateVramUsage(model)!;
      // Should use gptq-4bit (0.5 bytes/param) for the best estimate
      // 70B * 0.5 / (1024^3) * 1.2 ≈ 39GB
      expect(vram).toBeLessThan(50);
    });
  });

  describe('getTotalVramGb', () => {
    it('should return correct VRAM for 2x A100 80GB (default)', () => {
      const filter = new ModelCandidateFilter('error');
      expect(filter.getTotalVramGb()).toBe(160);
    });

    it('should return correct VRAM for custom hardware', () => {
      const filter = new ModelCandidateFilter('error', {
        targetHardwareProfile: {
          gpuType: 'nvidia-l4',
          gpuCount: 8,
          ramGb: 384,
          cpuCores: 96,
          diskGb: 1000,
          machineType: 'g2-standard-96',
        },
      });
      expect(filter.getTotalVramGb()).toBe(192); // 8x 24GB
    });

    it('should return correct VRAM for single GPU', () => {
      const filter = new ModelCandidateFilter('error', {
        targetHardwareProfile: {
          gpuType: 'nvidia-a100-80gb',
          gpuCount: 1,
          ramGb: 340,
          cpuCores: 12,
          diskGb: 500,
          machineType: 'a2-highgpu-1g',
        },
      });
      expect(filter.getTotalVramGb()).toBe(80);
    });
  });

  describe('multiple rejection reasons', () => {
    it('should accumulate multiple rejections for a failing model', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        contextWindow: 4096,
        architecture: 'vit',
        supportsToolCalling: false,
      });
      const result = filter.evaluate(model);

      expect(result.passed).toBe(false);
      expect(result.rejections.length).toBeGreaterThanOrEqual(3);

      const criteria = result.rejections.map((r) => r.criterion);
      expect(criteria).toContain('context_size');
      expect(criteria).toContain('vllm_architecture');
      expect(criteria).toContain('tool_calling');
    });

    it('should list all rejection reasons with details', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        contextWindow: 2048,
        supportsToolCalling: false,
      });
      const result = filter.evaluate(model);

      for (const rejection of result.rejections) {
        expect(rejection.reason).toBeTruthy();
        expect(rejection.criterion).toBeTruthy();
        expect(typeof rejection.isHardRequirement).toBe('boolean');
      }
    });
  });

  describe('realistic model scenarios', () => {
    it('should accept Llama-3.1-70B-Instruct', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        id: 'meta-llama/Llama-3.1-70B-Instruct',
        name: 'Llama-3.1-70B-Instruct',
        architecture: 'llama',
        contextWindow: 131072,
        license: 'llama3.1',
        parameterCount: 70_000_000_000,
        quantizations: ['fp16', 'gptq-4bit', 'awq'],
        supportsToolCalling: true,
      });
      const result = filter.evaluate(model);

      expect(result.passed).toBe(true);
      expect(result.recommendedToolCallParser).toBe('llama3_json');
    });

    it('should accept Qwen2.5-72B-Instruct', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        id: 'Qwen/Qwen2.5-72B-Instruct',
        name: 'Qwen2.5-72B-Instruct',
        architecture: 'qwen2',
        contextWindow: 131072,
        license: 'apache-2.0',
        parameterCount: 72_000_000_000,
        quantizations: ['fp16', 'gptq', 'awq'],
        supportsToolCalling: true,
      });
      const result = filter.evaluate(model);

      expect(result.passed).toBe(true);
      expect(result.recommendedToolCallParser).toBe('hermes');
    });

    it('should accept Mistral-Large-Instruct', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        id: 'mistralai/Mistral-Large-Instruct-2407',
        name: 'Mistral-Large-Instruct-2407',
        architecture: 'mistral',
        contextWindow: 131072,
        license: 'apache-2.0',
        parameterCount: 123_000_000_000,
        quantizations: ['fp16', 'gptq-4bit'],
        supportsToolCalling: true,
      });
      const result = filter.evaluate(model);

      // With gptq-4bit: 123B * 0.5 / (1024^3) * 1.2 ≈ 68.8GB, fits in 160GB
      expect(result.passed).toBe(true);
      expect(result.recommendedToolCallParser).toBe('mistral');
    });

    it('should reject a base model (no tool calling)', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        id: 'meta-llama/Llama-3.1-70B',
        name: 'Llama-3.1-70B',
        architecture: 'llama',
        contextWindow: 131072,
        license: 'llama3.1',
        parameterCount: 70_000_000_000,
        quantizations: ['fp16'],
        supportsToolCalling: false,
      });
      const result = filter.evaluate(model);

      expect(result.passed).toBe(false);
      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(true);
    });

    it('should reject a model too large for 2x A100', () => {
      const filter = new ModelCandidateFilter('error');
      const model = createModelCandidate({
        id: 'meta-llama/Llama-3.1-405B-Instruct',
        name: 'Llama-3.1-405B-Instruct',
        architecture: 'llama',
        contextWindow: 131072,
        license: 'llama3.1',
        parameterCount: 405_000_000_000,
        quantizations: ['fp16'],
        supportsToolCalling: true,
      });
      const result = filter.evaluate(model);

      expect(result.passed).toBe(false);
      expect(result.rejections.some((r) => r.criterion === 'model_size')).toBe(true);
    });
  });
});
