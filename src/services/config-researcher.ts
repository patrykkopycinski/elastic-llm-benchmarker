import { modelInfo } from '@huggingface/hub';
import { getVllmParamsForModel } from './vllm-model-params.js';
import type { EnhancedVllmConfig } from '../types/reasoning.js';
import { createLogger } from '../utils/logger.js';
import { GB_PER_GPU_FOR_TENSOR_PARALLEL, DEFAULT_CONTEXT_WINDOW, REASONING_KEYWORDS } from './config-researcher-constants.js';
import { LRUCache } from 'lru-cache';
import CircuitBreaker from 'opossum';
import { metricsCollector } from './metrics-collector.js';

const logger = createLogger('info');

// Circuit breaker for HuggingFace API calls
// Prevents cascading failures when HF API is down or rate-limited
const hfApiBreaker = new CircuitBreaker(
  async (params: Parameters<typeof modelInfo>[0]) => await modelInfo(params),
  {
    timeout: 10000, // 10s timeout
    errorThresholdPercentage: 50, // Open after 50% errors
    resetTimeout: 30000, // Try again after 30s
    name: 'huggingface-api',
  }
);

hfApiBreaker.fallback(() => {
  logger.warn('HuggingFace API circuit breaker OPEN - using fallback config');
  return null;
});

hfApiBreaker.on('open', () => {
  logger.error('HuggingFace API circuit breaker OPENED - too many failures');
});

hfApiBreaker.on('halfOpen', () => {
  logger.info('HuggingFace API circuit breaker HALF-OPEN - testing recovery');
});

hfApiBreaker.on('close', () => {
  logger.info('HuggingFace API circuit breaker CLOSED - service recovered');
});

/**
 * Extended HuggingFace model info structure.
 * The @huggingface/hub package doesn't fully type expanded fields,
 * so we define our own interface.
 */
interface HFModelInfo {
  id: string;
  safetensors?: {
    total: number;
    parameters?: Record<string, number>;
  };
  config?: {
    architectures?: string[];
    max_position_embeddings?: number;
    hidden_size?: number;
    num_attention_heads?: number;
  };
  cardData?: Record<string, any>;
}

interface ConfigResearcherOptions {
  gpusAvailable: number;
  huggingfaceToken?: string;
  logLevel?: string;
}

export class ConfigResearcherService {
  private huggingfaceToken?: string;
  private logger;
  private gpusAvailable: number;
  private cache: LRUCache<string, EnhancedVllmConfig>;

  constructor(options: ConfigResearcherOptions) {
    this.gpusAvailable = options.gpusAvailable;
    this.logger = createLogger(options.logLevel || 'info');
    this.huggingfaceToken = options.huggingfaceToken;

    // Cache config research results (1 hour TTL, max 100 entries)
    this.cache = new LRUCache({
      max: 100,
      ttl: 1000 * 60 * 60,
    });
  }

  async research(modelId: string): Promise<EnhancedVllmConfig> {
    const opId = metricsCollector.startOperation('ConfigResearcher', 'research');

    try {
      // Check cache first
      const cached = this.cache.get(modelId);
      if (cached) {
        this.logger.debug('Using cached config', { modelId });
        metricsCollector.endOperation(opId, true);
        return cached;
      }

      // Research and cache
      const config = await this.doResearch(modelId);
      this.cache.set(modelId, config);
      metricsCollector.endOperation(opId, true);
      return config;
    } catch (error) {
      metricsCollector.endOperation(opId, false, error as Error);
      throw error;
    }
  }

  private async doResearch(modelId: string): Promise<EnhancedVllmConfig> {
    const baseParams = getVllmParamsForModel(modelId);

    let modelCard = null;
    try {
      modelCard = await this.fetchHFModelCard(modelId);
    } catch (error) {
      this.logger.warn('HF API failed, using defaults', { modelId, error });
    }

    const tensorParallel = modelCard?.parameterCountB
      ? Math.ceil(modelCard.parameterCountB / this.gpusAvailable / GB_PER_GPU_FOR_TENSOR_PARALLEL)
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
      maxModelLen: modelCard?.contextWindow || DEFAULT_CONTEXT_WINDOW,
      capabilities,
      reasoning: modelCard
        ? 'Based on HF card + vLLM docs'
        : 'Based on vLLM defaults (HF API unavailable)',
      dataSource: modelCard ? 'hf_api' : 'fallback',
    };
  }

  private async fetchHFModelCard(modelId: string): Promise<{
    id: string;
    architecture: string;
    parameterCountB: number | null;
    contextWindow: number;
    modelCard: Record<string, any> | undefined;
  }> {
    // Call HF API through circuit breaker
    const info = await hfApiBreaker.fire({
      name: modelId,
      credentials: this.huggingfaceToken ? { accessToken: this.huggingfaceToken } : undefined,
    });

    // Circuit breaker returns null on fallback
    if (!info) {
      throw new Error('HuggingFace API unavailable (circuit breaker open)');
    }

    // Cast to extended interface (HF API returns these fields but types don't expose them)
    // This is safer than 'as any' because we define the expected structure
    const extendedInfo = info as unknown as HFModelInfo;

    const paramCountB = extendedInfo.safetensors?.total
      ? extendedInfo.safetensors.total / 1_000_000_000
      : null;

    return {
      id: info.id,
      architecture: extendedInfo.config?.architectures?.[0] || 'unknown',
      parameterCountB: paramCountB,
      contextWindow: extendedInfo.config?.max_position_embeddings || DEFAULT_CONTEXT_WINDOW,
      modelCard: extendedInfo.cardData,
    };
  }

  private detectReasoning(modelId: string): boolean {
    // Use regex patterns to avoid false positives
    return REASONING_KEYWORDS.patterns.some(pattern => pattern.test(modelId));
  }
}
