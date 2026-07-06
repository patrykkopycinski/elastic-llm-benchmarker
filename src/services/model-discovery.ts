import type { ModelInfo } from '../types/benchmark.js';
import type { VMHardwareProfile } from '../types/config.js';
import { HardwareEstimator } from './hardware-estimator.js';
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
  [key: string]: unknown;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const HF_API_BASE = 'https://huggingface.co';
const MAX_PAGES = 10;
const MODELS_PER_PAGE = 100;
const DEFAULT_SEARCH = '';

/** Default whitelist for tool-calling–friendly model families. */
const DEFAULT_TOOL_CALLING_WHITELIST = new Set([
  'llama',
  'qwen2',
  'qwen2_moe',
  'qwen3',
  'qwen3_moe',
  // qwen3_5 / qwen3_5_moe = the Qwen3.6 generation (multimodal image-text-to-text
  // but text/tool-calling capable — Ornith-1.0 is post-trained on it). Included so
  // discovery re-surfaces the current-gen models auto, not only via manual enqueue.
  'qwen3_5',
  'qwen3_5_moe',
  'mistral',
  'mixtral',
]);

const defaultOptions: Required<ModelDiscoveryOptions> = {
  search: DEFAULT_SEARCH,
  sort: 'downloads',
  limit: 50,
  minContextWindow: 4096,
  minParameterCount: 0,
  includeGated: false,
};

/** Architecture families compatible with vLLM (transformers-based and MoE) */
const COMPATIBLE_ARCHITECTURES = new Set([
  'llama',
  'mistral',
  'mixtral',
  'qwen',
  'qwen2',
  'qwen2_moe',
  'qwen3',
  'qwen3_moe',
  'qwen3_5',
  'qwen3_5_moe',
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
]);

/** Known open-source / permissive license identifiers on HuggingFace */
const OPEN_SOURCE_LICENSES = new Set([
  'apache-2.0',
  'mit',
  'gpl-3.0',
  'bsd-3-clause',
  'bsd-2-clause',
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

/** Maps common HF tags to architecture family names. */
const TAG_ARCHITECTURES: Record<string, string> = {
  llama: 'llama',
  'llama-3': 'llama',
  'llama-2': 'llama',
  'llama-3.1': 'llama',
  'llama-3.2': 'llama',
  'llama-3.3': 'llama',
  mistral: 'mistral',
  mixtral: 'mixtral',
  'mixtral-8x7b': 'mixtral',
  'mixtral-8x22b': 'mixtral',
  qwen: 'qwen',
  'qwen2.5': 'qwen2',
  'qwen2.5-72b': 'qwen2',
  'qwen2.5-32b': 'qwen2',
  'qwen2.5-14b': 'qwen2',
  'qwen2.5-7b': 'qwen2',
  'qwen2-72b': 'qwen2',
  gemma: 'gemma',
  'gemma-2': 'gemma2',
  phi: 'phi',
  'phi-3': 'phi3',
  'phi-4': 'phi3',
  starcoder: 'starcoder2',
  codellama: 'codellama',
  deepseek: 'deepseek',
  'deepseek-v2': 'deepseek_v2',
  'deepseek-v3': 'deepseek_v3',
  internlm: 'internlm',
  yi: 'yi',
  baichuan: 'baichuan',
  chatglm: 'chatglm',
  falcon: 'falcon',
  mpt: 'mpt',
  bloom: 'bloom',
  opt: 'opt',
  gpt_neox: 'gpt_neox',
  gpt2: 'gpt2',
  gptj: 'gptj',
  stablelm: 'stablelm',
  'command-r': 'command-r',
  cohere: 'cohere',
  dbrx: 'dbrx',
  jamba: 'jamba',
  olmo: 'olmo',
  arctic: 'arctic',
  exaone: 'exaone',
};

// ─── Public Types ────────────────────────────────────────────────────────────

export interface ModelCandidate {
  id: string;
  name: string;
  architecture: string;
  contextWindow: number;
  license: string;
  parameterCount: number | null;
  quantizations: string[];
  supportsToolCalling: boolean;
}

export interface DiscoverResult {
  models: ModelCandidate[];
  totalRejected: number;
  totalScanned: number;
  timestamp: string;
}

export interface ModelDiscoveryOptions {
  search?: string;
  sort?: string;
  limit?: number;
  minContextWindow?: number;
  /**
   * Minimum parameter count (absolute, not billions). Models known to be
   * below this floor are rejected during discovery so the candidate list
   * fills with qualifying large models instead of stopping early on small,
   * high-download ones. Unknown parameter counts are not rejected here — the
   * downstream candidate filter warns on them instead.
   */
  minParameterCount?: number;
  includeGated?: boolean;
}

// Backwards-compat alias for consumers expecting the old name
export type DiscoveryResult = DiscoverResult;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Service for discovering candidate LLM models from HuggingFace.
 *
 * Searches the HuggingFace Hub for text-generation models that meet
 * specific criteria: minimum context window, open-source license,
 * compatible architectures (transformers, MoE), and hardware fit.
 *
 * Key M2 improvements:
 *  - Page-by-page evaluation with early exit once `limit` is reached.
 *  - Fast-reject path that checks model type and rough VRAM budget
 *    *before* fetching individual config.json files.
 *  - Deep hardware-fit check using HardwareEstimator after config.json
 *    is loaded.
 */
export class ModelDiscoveryService {
  private readonly logger;
  private readonly token: string;
  private readonly evaluatedModelIds: Set<string>;
  private readonly hardwareProfile?: VMHardwareProfile;
  private readonly hardwareEstimator: HardwareEstimator;
  private readonly targetVramGb: number;
  private readonly typeWhitelist: Set<string>;
  private readonly configCache = new Map<string, HFModelConfig | null>();
  private readonly infoCache = new Map<string, ModelInfo | null>();

  constructor(
    token: string,
    evaluatedModelIds: string[] = [],
    logLevel: string = 'info',
    hardwareProfile?: VMHardwareProfile,
    typeWhitelist?: string[],
  ) {
    this.logger = createLogger(logLevel);
    this.token = token;
    this.evaluatedModelIds = new Set(evaluatedModelIds);
    this.hardwareProfile = hardwareProfile;
    this.hardwareEstimator = new HardwareEstimator();
    this.typeWhitelist = new Set(
      typeWhitelist ?? Array.from(DEFAULT_TOOL_CALLING_WHITELIST),
    );

    if (hardwareProfile) {
      // Heuristic per-GPU VRAM table (mirrors HardwareEstimator)
      const gpuVramGb: Record<string, number> = {
        'nvidia-l4': 24,
        'nvidia-a100-80gb': 80,
        'nvidia-a100-sxm4-80gb': 80,
        'nvidia-a100-40gb': 40,
        'nvidia-t4': 16,
        'nvidia-v100': 32,
      };
      const perGpu = gpuVramGb[hardwareProfile.gpuType] ?? 24;
      // Reserve 5 % head-room for vLLM overhead / KV-cache bloom
      this.targetVramGb = perGpu * hardwareProfile.gpuCount * 0.95;
    } else {
      this.targetVramGb = Infinity;
    }

    this.logger.info(
      `ModelDiscoveryService initialized with ${this.evaluatedModelIds.size} evaluated models ` +
        `(targetVRAM=${this.targetVramGb === Infinity ? 'unlimited' : `${this.targetVramGb.toFixed(1)} GB`}, ` +
        `whitelist=[${Array.from(this.typeWhitelist).join(', ')}])`,
    );
  }

  // ─── Discovery Core ──────────────────────────────────────────────────────

  /**
   * Discover candidate models from HuggingFace.
   *
   * Evaluates models page-by-page so that we can stop as soon as we
   * collect `limit` viable candidates — no need to scan all 1 000
   * models upfront.
   */
  async discover(options: ModelDiscoveryOptions = {}): Promise<DiscoverResult> {
    const opts = { ...defaultOptions, ...options };
    const models: ModelCandidate[] = [];
    let totalRejected = 0;
    let totalScanned = 0;

    for await (const page of this.fetchModelPages(opts)) {
      for (const rawModel of page) {
        const id = rawModel.id as string;

        if (this.isEvaluated(id)) {
          totalRejected++;
          continue;
        }

        // ── Fast reject (no extra HTTP call) ──────────────────────────
        const reason = this.fastReject(rawModel as HFModelEntry);
        if (reason) {
          this.logger.debug(`Fast rejected ${id}: ${reason}`);
          totalRejected++;
          totalScanned++;
          continue;
        }

        totalScanned++;
        const candidate = await this.evaluateCandidate(
          rawModel as HFModelEntry,
          opts,
        );
        if (!candidate) {
          totalRejected++;
          continue;
        }

        models.push(candidate);
        if (models.length >= opts.limit) break;
      }
      if (models.length >= opts.limit) break;
    }

    this.logger.info(
      `Discovery complete: ${models.length} accepted, ${totalRejected} rejected from ${totalScanned} scanned`,
    );

    return {
      models,
      totalRejected,
      totalScanned,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Yield pages of HF search results so that `discover()` can
   * evaluate and exit early without holding every model in memory.
   */
  private async *fetchModelPages(
    options: ModelDiscoveryOptions,
  ): AsyncGenerator<HFModelEntry[]> {
    const { search, sort, includeGated } = options;
    let page = 0;

    while (page < MAX_PAGES) {
      const params = new URLSearchParams({
        search: search || DEFAULT_SEARCH,
        limit: String(MODELS_PER_PAGE),
        full: 'true',
        config: 'true',
        ...(sort ? { sort } : {}),
      });

      const response = await this.fetchWithAuth(
        `${HF_API_BASE}/api/models?${params}`,
      );

      if (!response.ok) {
        this.logger.error(
          `HF search failed: ${response.status} ${response.statusText}`,
        );
        break;
      }

      const data = (await response.json()) as HFModelEntry[];
      if (!Array.isArray(data) || data.length === 0) break;

      const visible = data.filter((m) => {
        if (m.private) return false;
        if (!includeGated && m.gated === true) return false;
        return true;
      });

      if (visible.length === 0) break;
      yield visible;

      // Stop if we got fewer results than page size — no more pages
      if (data.length < MODELS_PER_PAGE) break;

      page++;
    }
  }

  // ─── Evaluation Pipeline ─────────────────────────────────────────────────

  /**
   * Evaluate a single model in depth.
   *
   * This is the *expensive* path: it fetches config.json and optionally
   * model_info.json. VRAM fit is checked here with the exact config.
   */
  private async evaluateCandidate(
    rawModel: HFModelEntry,
    options: Required<ModelDiscoveryOptions>,
  ): Promise<ModelCandidate | null> {
    const id = rawModel.id;

    // Step 1: Fetch model config
    const config = await this.fetchModelConfig(id);
    if (!config) return null;

    // Step 2: Architecture compatibility
    const architecture = this.normalizeArchitecture(config);
    if (!architecture || !COMPATIBLE_ARCHITECTURES.has(architecture)) {
      return null;
    }

    // Step 3: Context window check
    const contextWindow = this.extractContextWindow(config);
    if (contextWindow < options.minContextWindow) {
      return null;
    }

    // Step 3.5: Parameter-count floor (Agent Builder baseline). A known count
    // below the floor is rejected here; an unknown count is left for the
    // downstream candidate filter to warn on rather than hard-reject.
    const parameterCount = this.extractParameterCount(rawModel);
    if (
      options.minParameterCount > 0 &&
      parameterCount !== null &&
      parameterCount < options.minParameterCount
    ) {
      return null;
    }

    // Step 4: License check
    const license = this.extractLicense(rawModel);
    if (!OPEN_SOURCE_LICENSES.has(license)) {
      return null;
    }

    // Step 5: Deep hardware-fit check
    if (this.hardwareProfile) {
      const fit = this.hardwareEstimator.dryRunCheck(config, this.hardwareProfile);
      if (!fit.fits) {
        this.logger.debug(`Rejected ${id}: ${fit.reason}`);
        return null;
      }
    }

    // Step 6: Extract metadata
    const quantizations = this.extractQuantizations(rawModel, config);
    const supportsToolCalling = this.detectToolCallingSupport(rawModel);

    const name = id.split('/').pop() ?? id;

    return {
      id,
      name,
      architecture,
      contextWindow,
      license,
      parameterCount,
      quantizations,
      supportsToolCalling,
    };
  }

  // ─── Fast Rejection ──────────────────────────────────────────────────────

  /**
   * Quick rejection heuristics that run *before* config.json is fetched.
   *
   * Returns a human-readable reason string if the model should be skipped,
   * or `null` if it passes and warrants the expensive deep evaluation.
   */
  private fastReject(model: HFModelEntry): string | null {
    // 1. Type whitelist (from search-result metadata)
    const modelType = this.extractModelTypeFromSearchResult(model);
    if (modelType && !this.typeWhitelist.has(modelType)) {
      return `type '${modelType}' not in whitelist`;
    }

    // 2. Rough VRAM budget check from parameter count
    if (this.targetVramGb !== Infinity) {
      const params = this.extractParameterCount(model);
      if (params && params > 0) {
        const estimatedGb = this.estimateVramGbFromParams(params);
        if (estimatedGb > this.targetVramGb) {
          return `estimated VRAM ${estimatedGb.toFixed(1)} GB > budget ${this.targetVramGb.toFixed(1)} GB`;
        }
      }
    }

    return null;
  }

  /** Extract model_type from the search result's embedded config object or tags. */
  private extractModelTypeFromSearchResult(model: HFModelEntry): string | null {
    if (model.config?.model_type) {
      return model.config.model_type;
    }
    return this.extractModelTypeFromTags(model.tags ?? []);
  }

  /** Heuristic: fp16 weights + 20 % overhead for KV-cache / activations. */
  private estimateVramGbFromParams(params: number): number {
    // 2 bytes/param (fp16/bf16) * 1.2 overhead factor
    return (params * 2 * 1.2) / (1024 ** 3);
  }

  // ─── Metadata Extraction (kept from original) ─────────────────────────────

  private normalizeArchitecture(config: HFModelConfig): string | null {
    if (config.model_type) return config.model_type;
    if (config.architectures?.length) {
      const cls = config.architectures[0] ?? '';
      if (!cls) return null;
      if (cls.includes('Llama')) return 'llama';
      if (cls.includes('Mistral')) return 'mistral';
      if (cls.includes('Mixtral')) return 'mixtral';
      if (cls.includes('Qwen')) return 'qwen2';
      if (cls.includes('Gemma')) return 'gemma';
      if (cls.includes('Phi')) return 'phi3';
      if (cls.includes('Deepseek')) return 'deepseek';
      if (cls.includes('DeepSeek')) return 'deepseek';
      if (cls.includes('Falcon')) return 'falcon';
      if (cls.includes('GPTNeoX')) return 'gpt_neox';
      if (cls.includes('GPT2')) return 'gpt2';
      if (cls.includes('Mpt')) return 'mpt';
      if (cls.includes('Bloom')) return 'bloom';
      if (cls.includes('OPT')) return 'opt';
      if (cls.includes('StableLm')) return 'stablelm';
      if (cls.includes('CommandR')) return 'command-r';
      if (cls.includes('Cohere')) return 'cohere';
    }
    return null;
  }

  private extractQuantizations(
    model: HFModelEntry,
    config: HFModelConfig,
  ): string[] {
    const quants = new Set<string>();

    if (config.quantization_config) {
      const method = config.quantization_config.quant_method;
      const bits = config.quantization_config.bits;

      if (method) {
        quants.add(method);
        if (bits) quants.add(`${method}-${bits}bit`);
      } else if (bits) {
        quants.add(`${bits}bit`);
      }
    }

    if (model.tags) {
      for (const tag of model.tags) {
        const lower = tag.toLowerCase();
        if (['awq', 'gptq', 'gguf', 'exl2', 'bq', 'q4', 'q5', 'q6', 'q8', 'int4', 'int8', 'fp16', 'bf16'].some((q) => lower.includes(q))) {
          quants.add(lower);
        }
      }
    }

    if (model.siblings) {
      for (const file of model.siblings) {
        if (file.rfilename.endsWith('.gguf')) {
          quants.add('gguf');
        }
      }
    }

    if (quants.size === 0) {
      // Default to fp16/bf16 if no quantization info found
      quants.add(model.siblings?.some((f) => f.rfilename.includes('bf16')) ? 'bf16' : 'fp16');
    }

    return Array.from(quants);
  }

  private detectToolCallingSupport(model: HFModelEntry): boolean {
    const id = model.id.toLowerCase();
    const tags = model.tags?.map((t) => t.toLowerCase()) ?? [];

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

    const chatIndicators = ['instruct', 'chat', 'it'];
    for (const indicator of chatIndicators) {
      if (id.includes(indicator)) return true;
    }

    return false;
  }

  private extractModelTypeFromTags(tags: string[]): string | null {
    if (!tags) return null;
    for (const tag of tags) {
      const lower = tag.toLowerCase();
      for (const [key, val] of Object.entries(TAG_ARCHITECTURES)) {
        if (lower.includes(key)) return val;
      }
    }
    return null;
  }

  /** Extracts parameter count from model metadata. */
  private extractParameterCount(model: HFModelEntry): number | null {
    if (model.tags) {
      for (const tag of model.tags) {
        const match = tag.match(/^params:(\d+)$/i);
        if (match?.[1]) {
          return parseInt(match[1], 10);
        }
      }
    }

    const nameMatch = model.id.match(/(\d+)[bB]/);
    if (nameMatch?.[1]) {
      return parseInt(nameMatch[1], 10) * 1_000_000_000;
    }

    return null;
  }

  private extractLicense(model: HFModelEntry): string {
    if (model.tags) {
      for (const tag of model.tags) {
        if (tag.startsWith('license:')) {
          return tag.split(':')[1] ?? 'unknown';
        }
      }
    }
    return 'unknown';
  }

  private extractContextWindow(config: HFModelConfig): number {
    let window = config.max_position_embeddings ?? config.max_sequence_length ?? 0;

    if (config.sliding_window && config.sliding_window > window) {
      window = config.sliding_window;
    }

    if (config.rope_scaling?.factor && config.rope_scaling.original_max_position_embeddings) {
      window = Math.round(
        config.rope_scaling.original_max_position_embeddings * config.rope_scaling.factor,
      );
    }

    return window;
  }

  // ─── Data Fetching ───────────────────────────────────────────────────────

  async fetchModelConfig(modelId: string): Promise<HFModelConfig | null> {
    if (this.configCache.has(modelId)) return this.configCache.get(modelId)!;
    try {
      const response = await this.fetchWithAuth(
        `${HF_API_BASE}/${modelId}/resolve/main/config.json`,
      );
      if (!response.ok) {
        this.logger.debug(`Failed to fetch config for ${modelId}: ${response.status}`);
        this.configCache.set(modelId, null);
        return null;
      }
      const config = (await response.json()) as HFModelConfig;
      this.configCache.set(modelId, config);
      return config;
    } catch (error) {
      this.logger.debug(`Error fetching config for ${modelId}: ${error}`);
      this.configCache.set(modelId, null);
      return null;
    }
  }

  async fetchModelInfo(modelId: string): Promise<ModelInfo | null> {
    if (this.infoCache.has(modelId)) return this.infoCache.get(modelId)!;
    try {
      const response = await this.fetchWithAuth(
        `${HF_API_BASE}/api/models/${modelId}`,
      );
      if (!response.ok) {
        this.infoCache.set(modelId, null);
        return null;
      }
      const info = (await response.json()) as ModelInfo;
      this.infoCache.set(modelId, info);
      return info;
    } catch {
      this.infoCache.set(modelId, null);
      return null;
    }
  }

  private async fetchWithAuth(url: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return fetch(url, { headers });
  }

  // ─── Evaluated-model bookkeeping ─────────────────────────────────────────

  markEvaluated(modelId: string): void {
    this.evaluatedModelIds.add(modelId);
  }

  isEvaluated(modelId: string): boolean {
    return this.evaluatedModelIds.has(modelId);
  }

  getEvaluatedModelIds(): string[] {
    return [...this.evaluatedModelIds].sort();
  }
}
