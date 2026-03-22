import type { ModelInfo } from '../types/benchmark.js';
import { createLogger } from '../utils/logger.js';

// ─── HuggingFace API Response Types ──────────────────────────────────────────

/** A single model entry returned by the HuggingFace model search API */
interface HFModelEntry {
  _id: string;
  id: string;
  modelId?: string;
  author?: string;
  sha?: string;
  lastModified?: string;
  private?: boolean;
  gated?: boolean | string;
  disabled?: boolean;
  tags?: string[];
  pipeline_tag?: string;
  library_name?: string;
  config?: {
    model_type?: string;
    architectures?: string[];
    [key: string]: unknown;
  };
  siblings?: Array<{ rfilename: string }>;
  [key: string]: unknown;
}

/** Model config.json contents from HuggingFace */
interface HFModelConfig {
  model_type?: string;
  architectures?: string[];
  max_position_embeddings?: number;
  max_sequence_length?: number;
  sliding_window?: number;
  rope_scaling?: {
    type?: string;
    factor?: number;
    original_max_position_embeddings?: number;
    [key: string]: unknown;
  };
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
  [key: string]: unknown;
}

/** Options for filtering model discovery */
export interface ModelDiscoveryOptions {
  /** Minimum context window size in tokens (default: 128000) */
  minContextWindow?: number;
  /** Maximum number of models to return (default: 50) */
  limit?: number;
  /** Search query string to filter models by name */
  search?: string;
  /** Whether to include gated models (default: true) */
  includeGated?: boolean;
}

/** Result of a discovery run with metadata */
export interface DiscoveryResult {
  /** Models that passed all filters */
  models: ModelInfo[];
  /** Total candidates scanned before filtering */
  totalScanned: number;
  /** Number of models rejected during filtering */
  totalRejected: number;
  /** Timestamp of the discovery run */
  timestamp: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const HF_API_BASE = 'https://huggingface.co/api';
const DEFAULT_MIN_CONTEXT_WINDOW = 128_000;
const DEFAULT_LIMIT = 50;
const SEARCH_PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** Open-source licenses accepted for model discovery */
const OPEN_SOURCE_LICENSES = new Set([
  'mit',
  'apache-2.0',
  'gpl-2.0',
  'gpl-3.0',
  'lgpl-2.1',
  'lgpl-3.0',
  'bsd-2-clause',
  'bsd-3-clause',
  'mpl-2.0',
  'cc-by-4.0',
  'cc-by-sa-4.0',
  'cc-by-nc-4.0',
  'cc-by-nc-sa-4.0',
  'cc0-1.0',
  'unlicense',
  'isc',
  'artistic-2.0',
  'openrail',
  'openrail++',
  'bigscience-openrail-m',
  'bigcode-openrail-m',
  'creativeml-openrail-m',
  'bigscience-bloom-rail-1.0',
  'llama2',
  'llama3',
  'llama3.1',
  'llama3.2',
  'llama3.3',
  'gemma',
  'other',
]);

/** Architecture families compatible with vLLM (transformers-based and MoE) */
const COMPATIBLE_ARCHITECTURES = new Set([
  // Standard transformer architectures
  'llama',
  'mistral',
  'mixtral',
  'qwen',
  'qwen2',
  'qwen2_moe',
  'gemma',
  'gemma2',
  'phi',
  'phi3',
  'starcoder2',
  'codellama',
  'deepseek',
  'deepseek_v2',
  'deepseek_v3',
  'internlm',
  'internlm2',
  'yi',
  'baichuan',
  'chatglm',
  'falcon',
  'mpt',
  'bloom',
  'opt',
  'gpt_neox',
  'gpt2',
  'gptj',
  'stablelm',
  'command-r',
  'cohere',
  'dbrx',
  'jamba',
  'olmo',
  'arctic',
  'exaone',
  // MoE architectures
  'mixtral',
  'qwen2_moe',
  'deepseek_v2',
  'deepseek_v3',
  'dbrx',
  'arctic',
  'jamba',
]);

/**
 * Service for discovering candidate LLM models from HuggingFace.
 *
 * Searches the HuggingFace Hub for text-generation models that meet
 * specific criteria: minimum context window, open-source license,
 * and compatible architectures (transformers, MoE). Fetches model
 * cards and config.json to extract detailed model information.
 *
 * Tracks already-evaluated models to avoid re-testing.
 */
export class ModelDiscoveryService {
  private readonly logger;
  private readonly token: string;
  private readonly evaluatedModelIds: Set<string>;

  /**
   * Creates a new ModelDiscoveryService instance.
   *
   * @param token - HuggingFace API token for authenticated requests
   * @param evaluatedModelIds - Set of model IDs already evaluated (to skip)
   * @param logLevel - Winston log level (default: 'info')
   */
  constructor(token: string, evaluatedModelIds: string[] = [], logLevel: string = 'info') {
    this.logger = createLogger(logLevel);
    this.token = token;
    this.evaluatedModelIds = new Set(evaluatedModelIds);

    this.logger.info(
      `ModelDiscoveryService initialized with ${this.evaluatedModelIds.size} evaluated models`,
    );
  }

  /**
   * Discovers candidate models from HuggingFace Hub.
   *
   * Searches for text-generation models and filters by:
   * - Context window >= minContextWindow (default: 128K tokens)
   * - Open-source license
   * - Compatible architecture (transformers, MoE)
   * - Not already evaluated
   *
   * @param options - Discovery filter options
   * @returns Discovery result with filtered models and scan metadata
   */
  async discover(options: ModelDiscoveryOptions = {}): Promise<DiscoveryResult> {
    const minContextWindow = options.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW;
    const limit = options.limit ?? DEFAULT_LIMIT;
    const includeGated = options.includeGated ?? true;

    this.logger.info('Starting model discovery', { minContextWindow, limit });

    const candidates = await this.searchModels(options.search, includeGated);
    this.logger.info(`Found ${candidates.length} text-generation candidates from HuggingFace`);

    const models: ModelInfo[] = [];
    let totalRejected = 0;

    for (const candidate of candidates) {
      if (models.length >= limit) {
        break;
      }

      // Skip already-evaluated models
      if (this.evaluatedModelIds.has(candidate.id)) {
        this.logger.debug(`Skipping already-evaluated model: ${candidate.id}`);
        totalRejected++;
        continue;
      }

      try {
        const modelInfo = await this.evaluateCandidate(candidate, minContextWindow);
        if (modelInfo) {
          models.push(modelInfo);
          this.logger.info(`Accepted model: ${modelInfo.id}`, {
            architecture: modelInfo.architecture,
            contextWindow: modelInfo.contextWindow,
            license: modelInfo.license,
          });
        } else {
          totalRejected++;
        }
      } catch (err) {
        this.logger.warn(`Failed to evaluate candidate ${candidate.id}: ${String(err)}`);
        totalRejected++;
      }
    }

    const result: DiscoveryResult = {
      models,
      totalScanned: candidates.length,
      totalRejected,
      timestamp: new Date().toISOString(),
    };

    this.logger.info(
      `Discovery complete: ${models.length} models accepted, ${totalRejected} rejected out of ${candidates.length} scanned`,
    );

    return result;
  }

  /**
   * Marks a model as evaluated so it won't be returned in future discoveries.
   *
   * @param modelId - The HuggingFace model ID to mark as evaluated
   */
  markEvaluated(modelId: string): void {
    this.evaluatedModelIds.add(modelId);
    this.logger.debug(`Marked model as evaluated: ${modelId}`);
  }

  /**
   * Checks whether a model has already been evaluated.
   *
   * @param modelId - The HuggingFace model ID to check
   * @returns true if the model has been evaluated
   */
  isEvaluated(modelId: string): boolean {
    return this.evaluatedModelIds.has(modelId);
  }

  /**
   * Returns the set of all evaluated model IDs.
   *
   * @returns Array of evaluated model IDs
   */
  getEvaluatedModelIds(): string[] {
    return Array.from(this.evaluatedModelIds).sort();
  }

  /**
   * Fetches the config.json for a specific model from HuggingFace.
   *
   * @param modelId - The HuggingFace model ID
   * @returns The parsed model configuration, or null if unavailable
   */
  async fetchModelConfig(modelId: string): Promise<HFModelConfig | null> {
    try {
      const url = `${HF_API_BASE}/models/${modelId}/resolve/main/config.json`;
      const response = await this.fetchWithAuth(url);

      if (!response.ok) {
        this.logger.debug(`No config.json for ${modelId}: HTTP ${response.status}`);
        return null;
      }

      return (await response.json()) as HFModelConfig;
    } catch (err) {
      this.logger.debug(`Failed to fetch config.json for ${modelId}: ${String(err)}`);
      return null;
    }
  }

  /**
   * Fetches detailed model info from the HuggingFace API for a single model.
   *
   * @param modelId - The HuggingFace model ID
   * @returns The model entry, or null if not found
   */
  async fetchModelInfo(modelId: string): Promise<HFModelEntry | null> {
    try {
      const url = `${HF_API_BASE}/models/${modelId}`;
      const response = await this.fetchWithAuth(url);

      if (!response.ok) {
        this.logger.debug(`Model not found: ${modelId}: HTTP ${response.status}`);
        return null;
      }

      return (await response.json()) as HFModelEntry;
    } catch (err) {
      this.logger.debug(`Failed to fetch model info for ${modelId}: ${String(err)}`);
      return null;
    }
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  /**
   * Searches HuggingFace for text-generation models, paginating through results.
   */
  private async searchModels(
    search?: string,
    includeGated: boolean = true,
  ): Promise<HFModelEntry[]> {
    const allModels: HFModelEntry[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        pipeline_tag: 'text-generation',
        sort: 'downloads',
        direction: '-1',
        limit: String(SEARCH_PAGE_SIZE),
        offset: String(page * SEARCH_PAGE_SIZE),
        full: 'true',
        config: 'true',
      });

      if (search) {
        params.set('search', search);
      }

      const url = `${HF_API_BASE}/models?${params.toString()}`;
      const response = await this.fetchWithAuth(url);

      if (!response.ok) {
        this.logger.warn(`HuggingFace API error: HTTP ${response.status}`);
        break;
      }

      const models = (await response.json()) as HFModelEntry[];

      if (models.length === 0) {
        break;
      }

      // Filter out private and optionally gated models early
      const filtered = models.filter((m) => {
        if (m.private) return false;
        if (!includeGated && m.gated) return false;
        return true;
      });

      allModels.push(...filtered);

      // Stop if we got fewer results than page size (last page)
      if (models.length < SEARCH_PAGE_SIZE) {
        break;
      }
    }

    return allModels;
  }

  /**
   * Evaluates a single candidate model against all filter criteria.
   * Returns a ModelInfo if accepted, null if rejected.
   */
  private async evaluateCandidate(
    candidate: HFModelEntry,
    minContextWindow: number,
  ): Promise<ModelInfo | null> {
    // Step 1: Check license
    const license = this.extractLicense(candidate);
    if (!this.isOpenSourceLicense(license)) {
      this.logger.debug(`Rejected ${candidate.id}: license '${license}' not open-source`);
      return null;
    }

    // Step 2: Fetch config.json for detailed architecture info
    const config = await this.fetchModelConfig(candidate.id);

    // Step 3: Check architecture compatibility
    const architecture = this.extractArchitecture(candidate, config);
    if (!this.isCompatibleArchitecture(architecture)) {
      this.logger.debug(`Rejected ${candidate.id}: architecture '${architecture}' not compatible`);
      return null;
    }

    // Step 4: Check context window
    const contextWindow = this.extractContextWindow(config);
    if (contextWindow < minContextWindow) {
      this.logger.debug(
        `Rejected ${candidate.id}: context window ${contextWindow} < ${minContextWindow}`,
      );
      return null;
    }

    // Step 5: Extract additional metadata
    const quantizations = this.extractQuantizations(candidate, config);
    const parameterCount = this.extractParameterCount(candidate);
    const supportsToolCalling = this.detectToolCallingSupport(candidate);

    return {
      id: candidate.id,
      name: candidate.id.split('/').pop() ?? candidate.id,
      architecture,
      contextWindow,
      license,
      parameterCount,
      quantizations,
      supportsToolCalling,
    };
  }

  /**
   * Extracts the license from a HuggingFace model entry.
   */
  private extractLicense(model: HFModelEntry): string {
    // Tags often contain license info
    if (model.tags) {
      for (const tag of model.tags) {
        if (tag.startsWith('license:')) {
          return tag.replace('license:', '').toLowerCase();
        }
      }
    }

    return 'unknown';
  }

  /**
   * Checks whether a license is considered open-source.
   */
  private isOpenSourceLicense(license: string): boolean {
    return OPEN_SOURCE_LICENSES.has(license.toLowerCase());
  }

  /**
   * Extracts the model architecture from API metadata and config.json.
   */
  private extractArchitecture(model: HFModelEntry, config: HFModelConfig | null): string {
    // Prefer config.json model_type
    if (config?.model_type) {
      return config.model_type.toLowerCase();
    }

    // Fall back to API config field
    if (model.config?.model_type) {
      return model.config.model_type.toLowerCase();
    }

    // Fall back to architectures array
    if (config?.architectures?.[0]) {
      return this.normalizeArchitectureName(config.architectures[0]);
    }

    if (model.config?.architectures?.[0]) {
      return this.normalizeArchitectureName(model.config.architectures[0]);
    }

    // Check library name
    if (model.library_name) {
      return model.library_name.toLowerCase();
    }

    return 'unknown';
  }

  /**
   * Normalizes a full architecture class name to a model type string.
   * e.g., "LlamaForCausalLM" -> "llama"
   */
  private normalizeArchitectureName(name: string): string {
    // Remove common suffixes
    const normalized = name
      .replace(/ForCausalLM$/i, '')
      .replace(/ForConditionalGeneration$/i, '')
      .replace(/Model$/i, '')
      .replace(/LMHead$/i, '')
      .toLowerCase();

    return normalized;
  }

  /**
   * Checks whether an architecture is compatible with vLLM.
   */
  private isCompatibleArchitecture(architecture: string): boolean {
    const normalized = architecture.toLowerCase();

    // Direct match
    if (COMPATIBLE_ARCHITECTURES.has(normalized)) {
      return true;
    }

    // Partial match (e.g., "qwen2" matches "qwen2_moe")
    const archArray = Array.from(COMPATIBLE_ARCHITECTURES);
    for (const arch of archArray) {
      if (normalized.includes(arch) || arch.includes(normalized)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extracts the effective context window size from model configuration.
   * Accounts for rope_scaling which can extend the native context window.
   */
  private extractContextWindow(config: HFModelConfig | null): number {
    if (!config) {
      return 0;
    }

    // Start with max_position_embeddings (most common field)
    let contextSize = config.max_position_embeddings ?? config.max_sequence_length ?? 0;

    // Check for rope_scaling which can extend context
    if (config.rope_scaling) {
      const factor = config.rope_scaling.factor ?? 1;
      const baseSize = config.rope_scaling.original_max_position_embeddings ?? contextSize;

      // If the reported max_position_embeddings is already scaled, use it directly
      // Otherwise, apply the scaling factor
      if (contextSize < baseSize * factor) {
        contextSize = Math.floor(baseSize * factor);
      }
    }

    return contextSize;
  }

  /**
   * Extracts available quantization options from model metadata.
   */
  private extractQuantizations(model: HFModelEntry, config: HFModelConfig | null): string[] {
    const quantizations: Set<string> = new Set();

    // Check config quantization
    if (config?.quantization_config?.quant_method) {
      quantizations.add(config.quantization_config.quant_method);
      if (config.quantization_config.bits) {
        quantizations.add(
          `${config.quantization_config.quant_method}-${config.quantization_config.bits}bit`,
        );
      }
    }

    // Check tags for quantization info
    if (model.tags) {
      for (const tag of model.tags) {
        const lowerTag = tag.toLowerCase();
        if (
          lowerTag.includes('gptq') ||
          lowerTag.includes('awq') ||
          lowerTag.includes('gguf') ||
          lowerTag.includes('bnb') ||
          lowerTag.includes('fp16') ||
          lowerTag.includes('bf16') ||
          lowerTag.includes('fp8') ||
          lowerTag.includes('int8') ||
          lowerTag.includes('int4') ||
          lowerTag.includes('4bit') ||
          lowerTag.includes('8bit')
        ) {
          quantizations.add(lowerTag);
        }
      }
    }

    // Check siblings for quantized model files
    if (model.siblings) {
      for (const sibling of model.siblings) {
        const filename = sibling.rfilename.toLowerCase();
        if (filename.includes('gptq')) quantizations.add('gptq');
        if (filename.includes('awq')) quantizations.add('awq');
        if (filename.endsWith('.gguf')) quantizations.add('gguf');
      }
    }

    // Always include fp16/bf16 as baseline
    if (quantizations.size === 0) {
      quantizations.add('fp16');
    }

    return Array.from(quantizations).sort();
  }

  /**
   * Extracts parameter count from model metadata.
   */
  private extractParameterCount(model: HFModelEntry): number | null {
    // Check tags for parameter count
    if (model.tags) {
      for (const tag of model.tags) {
        const match = tag.match(/^params:(\d+)$/i);
        if (match?.[1]) {
          return parseInt(match[1], 10);
        }
      }
    }

    // Try to extract from model name
    const nameMatch = model.id.match(/(\d+)[bB]/);
    if (nameMatch?.[1]) {
      return parseInt(nameMatch[1], 10) * 1_000_000_000;
    }

    return null;
  }

  /**
   * Detects whether a model likely supports tool/function calling
   * based on tags and model name heuristics.
   */
  private detectToolCallingSupport(model: HFModelEntry): boolean {
    const id = model.id.toLowerCase();
    const tags = model.tags?.map((t) => t.toLowerCase()) ?? [];

    // Check for explicit tool calling indicators
    const toolIndicators = [
      'tool-calling',
      'function-calling',
      'tool_use',
      'tool-use',
      'tools',
      'functioncalling',
    ];

    for (const indicator of toolIndicators) {
      if (tags.some((t) => t.includes(indicator))) return true;
      if (id.includes(indicator)) return true;
    }

    // Chat/instruct models often support tool calling
    const chatIndicators = ['instruct', 'chat', 'it'];
    for (const indicator of chatIndicators) {
      if (id.includes(indicator)) return true;
    }

    return false;
  }

  /**
   * Makes an authenticated fetch request to the HuggingFace API.
   */
  private async fetchWithAuth(url: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    return fetch(url, { headers });
  }
}
