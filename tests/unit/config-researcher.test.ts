import { describe, it, expect, vi } from 'vitest';
import { ConfigResearcherService } from '../../src/services/config-researcher.js';

vi.mock('@huggingface/hub', () => ({
  modelInfo: vi.fn().mockResolvedValue({
    id: 'meta-llama/Llama-3.3-70B-Instruct',
    config: {
      architectures: ['LlamaForCausalLM'],
      max_position_embeddings: 8192,
    },
    safetensors: {
      total: 70000000000, // 70B params
    },
    cardData: {},
  }),
}));

describe('ConfigResearcherService', () => {
  it('should calculate tensor parallel based on model size', async () => {
    const service = new ConfigResearcherService({ gpusAvailable: 2 });
    const config = await service.research('meta-llama/Llama-3.3-70B-Instruct');

    expect(config.tensorParallelSize).toBe(1); // 70B / 2 GPUs / 35B = 1, ceil = 1
  });

  it('should fallback to defaults if HF API fails', async () => {
    const service = new ConfigResearcherService({ gpusAvailable: 2 });
    vi.spyOn(service as any, 'fetchHFModelCard').mockRejectedValue(new Error('API failed'));

    const config = await service.research('unknown/model');

    expect(config.tensorParallelSize).toBe(1); // Conservative default
    expect(config.dataSource).toBe('fallback');
  });
});
