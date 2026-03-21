import { getVllmParamsForModel } from './vllm-model-params.js';
import type { ModelCapabilities } from '../types/reasoning.js';

/**
 * Service for detecting model capabilities (tool calling, reasoning, parallel calls).
 * Wraps existing vllm-model-params logic and adds reasoning detection.
 */
export class CapabilityDetectionService {
  /**
   * Detect all capabilities for a given model.
   *
   * @param modelId - HuggingFace model ID (e.g., "meta-llama/Llama-3.3-70B-Instruct")
   * @returns ModelCapabilities object with tool calling, reasoning, and parallel call support
   */
  async detect(modelId: string): Promise<ModelCapabilities> {
    const params = getVllmParamsForModel(modelId);

    return {
      toolCalling: {
        supported: params.toolCallParser != null,
        parser: params.toolCallParser,
      },
      reasoning: {
        supported: this.detectReasoning(modelId),
        method: 'native',
      },
      parallelToolCalls: params.toolCallParser != null,
    };
  }

  /**
   * Detect reasoning capability from model name/ID.
   * Uses keyword matching for known reasoning-capable models.
   */
  private detectReasoning(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    const keywords = ['reasoning', 'r1', 'o1', 'deepseek-r', 'qwq', 'extended-thinking'];
    return keywords.some(kw => lower.includes(kw));
  }
}
