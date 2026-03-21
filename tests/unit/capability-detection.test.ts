import { describe, it, expect } from 'vitest';
import { CapabilityDetectionService } from '../../src/services/capability-detection.js';

describe('CapabilityDetectionService', () => {
  it('should detect tool calling from vllm params', async () => {
    const service = new CapabilityDetectionService();
    const caps = await service.detect('meta-llama/Llama-3.3-70B-Instruct');

    expect(caps.toolCalling.supported).toBe(true);
    expect(caps.toolCalling.parser).toBe('llama3_json');
  });

  it('should detect reasoning from model name keywords', async () => {
    const service = new CapabilityDetectionService();
    const caps = await service.detect('deepseek-ai/DeepSeek-R1');

    expect(caps.reasoning.supported).toBe(true);
  });

  it('should return false for models without reasoning', async () => {
    const service = new CapabilityDetectionService();
    const caps = await service.detect('meta-llama/Llama-2-7b');

    expect(caps.reasoning.supported).toBe(false);
  });
});
