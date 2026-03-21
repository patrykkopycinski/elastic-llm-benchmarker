import { modelInfo } from '@huggingface/hub';
import { getVllmParamsForModel } from './vllm-model-params.js';
import type { EnhancedVllmConfig } from '../types/reasoning.js';
import { createLogger } from '../utils/logger.js';

interface ConfigResearcherOptions {
  gpusAvailable: number;
  huggingfaceToken?: string;
  logLevel?: string;
}

export class ConfigResearcherService {
  private huggingfaceToken?: string;
  private logger;
  private gpusAvailable: number;

  constructor(options: ConfigResearcherOptions) {
    this.gpusAvailable = options.gpusAvailable;
    this.logger = createLogger(options.logLevel || 'info');
    this.huggingfaceToken = options.huggingfaceToken;
  }

  async research(modelId: string): Promise<EnhancedVllmConfig> {
    const baseParams = getVllmParamsForModel(modelId);

    let modelCard = null;
    try {
      modelCard = await this.fetchHFModelCard(modelId);
    } catch (error) {
      this.logger.warn('HF API failed, using defaults', { modelId, error });
    }

    const tensorParallel = modelCard?.parameterCountB
      ? Math.ceil(modelCard.parameterCountB / this.gpusAvailable / 35)
      : 1;

    const capabilities = {
      toolCalling: {
        supported: baseParams.toolCallParser != null,
        parser: baseParams.toolCallParser,
      },
      reasoning: {
        supported: modelCard ? this.detectReasoning(modelId) : false,
        method: 'native' as const,
      },
      parallelToolCalls: baseParams.toolCallParser != null,
    };

    return {
      ...baseParams,
      tensorParallelSize: tensorParallel,
      maxModelLen: modelCard?.contextWindow || 8192,
      capabilities,
      reasoning: modelCard
        ? 'Based on HF card + vLLM docs'
        : 'Based on vLLM defaults (HF API unavailable)',
      dataSource: modelCard ? 'hf_api' : 'fallback',
    };
  }

  private async fetchHFModelCard(modelId: string) {
    const info = await modelInfo({
      name: modelId,
      credentials: this.huggingfaceToken ? { accessToken: this.huggingfaceToken } : undefined,
    });

    // Note: ModelEntry doesn't have safetensors/config/cardData by default
    // Using 'any' for now as the expand feature types aren't fully exposed
    const infoAny = info as any;

    const paramCountB = infoAny.safetensors?.total
      ? infoAny.safetensors.total / 1_000_000_000
      : null;

    return {
      id: info.id,
      architecture: infoAny.config?.architectures?.[0] || 'unknown',
      parameterCountB: paramCountB,
      contextWindow: infoAny.config?.max_position_embeddings || 8192,
      modelCard: infoAny.cardData,
    };
  }

  private detectReasoning(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    const keywords = ['reasoning', 'r1', 'o1', 'deepseek-r', 'qwq'];
    return keywords.some(kw => lower.includes(kw));
  }
}
