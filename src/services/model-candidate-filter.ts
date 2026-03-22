import type { ModelInfo } from '../types/benchmark.js';
import type { VMHardwareProfile } from '../types/config.js';
import { createLogger } from '../utils/logger.js';

// ─── Filter Result Types ─────────────────────────────────────────────────────

/** Reason a model was rejected during pre-deployment filtering */
export interface FilterRejection {
  /** The filter criterion that rejected the model */
  criterion: FilterCriterion;
  /** Human-readable explanation of why the model was rejected */
  reason: string;
  /** Whether this criterion is a hard requirement (vs. soft/warning) */
  isHardRequirement: boolean;
}

/** Filter criteria identifiers */
export type FilterCriterion =
  | 'context_size'
  | 'model_size'
  | 'vllm_architecture'
  | 'tool_calling'
  | 'known_failure';

/** Result of filtering a single model candidate */
export interface FilterResult {
  /** The model that was evaluated */
  model: ModelInfo;
  /** Whether the model passed all hard requirement filters */
  passed: boolean;
  /** Rejections (hard failures that block deployment) */
  rejections: FilterRejection[];
  /** Warnings (soft failures that don't block but are noteworthy) */
  warnings: FilterRejection[];
  /** The recommended vLLM tool call parser for this model, if applicable */
  recommendedToolCallParser: string | null;
  /** Estimated VRAM usage in GB (approximate) */
  estimatedVramGb: number | null;
}

/** Result of filtering a batch of model candidates */
export interface BatchFilterResult {
  /** Models that passed all hard requirement filters */
  passed: FilterResult[];
  /** Models that were rejected by one or more hard requirement filters */
  rejected: FilterResult[];
  /** Total number of models evaluated */
  totalEvaluated: number;
  /** Timestamp of the filter run */
  timestamp: string;
}

/** Configuration options for the candidate filter */
export interface CandidateFilterOptions {
  /** Minimum context window size in tokens (default: 128000) */
  minContextWindow?: number;
  /** Target hardware profile for model size fitting (default: 2x A100 80GB) */
  targetHardwareProfile?: VMHardwareProfile;
  /** Whether to require tool calling support (default: true) */
  requireToolCalling?: boolean;
  /** Whether to check against known failure list (default: true) */
  checkKnownFailures?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MIN_CONTEXT_WINDOW = 128_000;

/**
 * Default target hardware: 2x A100 80GB = 160GB total VRAM.
 * Models must fit within this VRAM budget.
 */
const DEFAULT_TARGET_HARDWARE: VMHardwareProfile = {
  gpuType: 'nvidia-a100-80gb',
  gpuCount: 2,
  ramGb: 680,
  cpuCores: 24,
  diskGb: 1000,
  machineType: 'a2-ultragpu-2g',
};

/** Bytes per parameter for different precisions */
const BYTES_PER_PARAM: Record<string, number> = {
  fp32: 4,
  fp16: 2,
  bf16: 2,
  fp8: 1,
  int8: 1,
  int4: 0.5,
  'gptq-4bit': 0.5,
  'gptq-8bit': 1,
  'awq-4bit': 0.5,
  gptq: 0.5,
  awq: 0.5,
  '4bit': 0.5,
  '8bit': 1,
};

/** VRAM per GPU for known GPU types (in GB) */
const GPU_VRAM_GB: Record<string, number> = {
  'nvidia-a100-80gb': 80,
  'nvidia-a100-40gb': 40,
  'nvidia-a100': 80,
  'nvidia-h100': 80,
  'nvidia-l4': 24,
  'nvidia-t4': 16,
  'nvidia-v100': 16,
  'nvidia-a10g': 24,
};

/**
 * vLLM supported architectures with their corresponding tool call parser.
 * Only model families that have verified vLLM tool calling support are listed.
 */
const VLLM_TOOL_CALL_PARSERS: Record<string, string> = {
  // Hermes-style tool calling (Qwen, NousResearch Hermes models)
  qwen: 'hermes',
  qwen2: 'hermes',
  qwen2_moe: 'hermes',
  // Mistral-native tool calling
  mistral: 'mistral',
  mixtral: 'mistral',
  // Llama 3 JSON-based tool calling
  llama: 'llama3_json',
  codellama: 'llama3_json',
};

/**
 * Architectures that vLLM supports for inference (broader than tool-calling list).
 */
const VLLM_SUPPORTED_ARCHITECTURES = new Set([
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
]);

/**
 * Models known to fail deployment or benchmarking.
 * These are auto-skipped during pre-filtering to save time and resources.
 *
 * Format: exact model ID or prefix pattern (ending with '*').
 */
const KNOWN_FAILURE_LIST: ReadonlyMap<string, string> = new Map([
  // Models with known OOM issues on 2x A100 80GB
  ['tiiuae/falcon-180B', 'Exceeds 2x A100 80GB VRAM even with quantization'],
  ['bigscience/bloom', 'Exceeds 2x A100 80GB VRAM (176B parameters)'],
  ['EleutherAI/gpt-neox-20b', 'Known vLLM compatibility issues with this specific checkpoint'],
  // Models with broken tool calling despite claiming support
  ['stabilityai/stablelm-2-*', 'Tool calling not reliably supported in vLLM'],
  // Models known to produce incorrect outputs with vLLM
  ['mosaicml/mpt-30b-*', 'Known inference issues with vLLM serving'],
]);

// ─── Model Candidate Filter Service ──────────────────────────────────────────

/**
 * Pre-deployment filter service for LLM model candidates.
 *
 * Evaluates models against deployment criteria before committing
 * expensive GPU resources for benchmarking. Filters include:
 *
 * 1. **Context Size** (hard): Model must support >= 128K tokens
 * 2. **Model Size** (hard): Model must fit in target hardware (2x A100 80GB)
 * 3. **vLLM Architecture** (hard): Architecture must be supported by vLLM
 * 4. **Tool Calling** (configurable): Model family must support tool calling
 *    with a known vLLM parser (hermes, mistral, llama3_json)
 * 5. **Known Failures** (hard): Auto-skip models known to fail
 *
 * @example
 * ```typescript
 * const filter = new ModelCandidateFilter('info');
 * const result = filter.evaluate(modelInfo);
 *
 * if (result.passed) {
 *   console.log(`Model ${result.model.id} passed with parser: ${result.recommendedToolCallParser}`);
 * } else {
 *   console.log(`Rejected: ${result.rejections.map(r => r.reason).join(', ')}`);
 * }
 * ```
 */
export class ModelCandidateFilter {
  private readonly logger;
  private readonly minContextWindow: number;
  private readonly targetHardware: VMHardwareProfile;
  private readonly requireToolCalling: boolean;
  private readonly checkKnownFailures: boolean;

  /**
   * Creates a new ModelCandidateFilter instance.
   *
   * @param logLevel - Winston log level (default: 'info')
   * @param options - Filter configuration options
   */
  constructor(logLevel: string = 'info', options: CandidateFilterOptions = {}) {
    this.logger = createLogger(logLevel);
    this.minContextWindow = options.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW;
    this.targetHardware = options.targetHardwareProfile ?? DEFAULT_TARGET_HARDWARE;
    this.requireToolCalling = options.requireToolCalling ?? true;
    this.checkKnownFailures = options.checkKnownFailures ?? true;

    this.logger.info('ModelCandidateFilter initialized', {
      minContextWindow: this.minContextWindow,
      targetGpu: `${this.targetHardware.gpuCount}x ${this.targetHardware.gpuType}`,
      requireToolCalling: this.requireToolCalling,
    });
  }

  /**
   * Evaluates a single model candidate against all pre-deployment filter criteria.
   *
   * @param model - The model candidate to evaluate
   * @returns Filter result with pass/fail status, rejections, and warnings
   */
  evaluate(model: ModelInfo): FilterResult {
    const rejections: FilterRejection[] = [];
    const warnings: FilterRejection[] = [];

    this.logger.debug(`Evaluating candidate: ${model.id}`);

    // Filter 1: Known failure check (fastest, do first)
    if (this.checkKnownFailures) {
      const knownFailure = this.checkKnownFailureList(model);
      if (knownFailure) {
        rejections.push(knownFailure);
      }
    }

    // Filter 2: Context size (hard requirement)
    const contextResult = this.checkContextSize(model);
    if (contextResult) {
      rejections.push(contextResult);
    }

    // Filter 3: vLLM architecture support (hard requirement)
    const archResult = this.checkVllmArchitecture(model);
    if (archResult) {
      rejections.push(archResult);
    }

    // Filter 4: Model size fits in target hardware
    const sizeResult = this.checkModelSize(model);
    if (sizeResult) {
      if (sizeResult.isHardRequirement) {
        rejections.push(sizeResult);
      } else {
        warnings.push(sizeResult);
      }
    }

    // Filter 5: Tool calling capability
    const toolResult = this.checkToolCalling(model);
    if (toolResult) {
      if (this.requireToolCalling) {
        rejections.push(toolResult);
      } else {
        warnings.push(toolResult);
      }
    }

    // Determine recommended tool call parser
    const recommendedToolCallParser = this.getRecommendedToolCallParser(model);

    // Estimate VRAM usage
    const estimatedVramGb = this.estimateVramUsage(model);

    const passed = rejections.length === 0;

    if (passed) {
      this.logger.info(`Model PASSED pre-deployment filter: ${model.id}`, {
        parser: recommendedToolCallParser,
        estimatedVramGb,
        warnings: warnings.length,
      });
    } else {
      this.logger.info(`Model REJECTED by pre-deployment filter: ${model.id}`, {
        rejections: rejections.map((r) => r.criterion),
      });
    }

    return {
      model,
      passed,
      rejections,
      warnings,
      recommendedToolCallParser,
      estimatedVramGb,
    };
  }

  /**
   * Evaluates a batch of model candidates and partitions them into
   * passed and rejected groups.
   *
   * @param models - Array of model candidates to evaluate
   * @returns Batch filter result with passed/rejected partitions
   */
  evaluateBatch(models: ModelInfo[]): BatchFilterResult {
    this.logger.info(`Evaluating batch of ${models.length} candidates`);

    const passed: FilterResult[] = [];
    const rejected: FilterResult[] = [];

    for (const model of models) {
      const result = this.evaluate(model);
      if (result.passed) {
        passed.push(result);
      } else {
        rejected.push(result);
      }
    }

    const batchResult: BatchFilterResult = {
      passed,
      rejected,
      totalEvaluated: models.length,
      timestamp: new Date().toISOString(),
    };

    this.logger.info(
      `Batch filter complete: ${passed.length} passed, ${rejected.length} rejected out of ${models.length}`,
    );

    return batchResult;
  }

  /**
   * Returns the total available VRAM for the target hardware in GB.
   */
  getTotalVramGb(): number {
    return this.calculateTotalVram(this.targetHardware);
  }

  /**
   * Returns the recommended vLLM tool call parser for a model architecture.
   *
   * @param model - The model to get the parser for
   * @returns Parser name or null if no parser is available
   */
  getRecommendedToolCallParser(model: ModelInfo): string | null {
    const arch = model.architecture.toLowerCase();

    // Direct match
    if (VLLM_TOOL_CALL_PARSERS[arch]) {
      return VLLM_TOOL_CALL_PARSERS[arch]!;
    }

    // Partial match for sub-architectures (e.g., "qwen2_moe" contains "qwen")
    for (const [archKey, parser] of Object.entries(VLLM_TOOL_CALL_PARSERS)) {
      if (arch.includes(archKey) || archKey.includes(arch)) {
        return parser;
      }
    }

    // Check model ID for family hints
    const modelId = model.id.toLowerCase();
    if (modelId.includes('qwen')) return 'hermes';
    if (modelId.includes('mistral') || modelId.includes('mixtral')) return 'mistral';
    if (modelId.includes('llama') || modelId.includes('codellama')) return 'llama3_json';

    return null;
  }

  /**
   * Estimates the VRAM usage of a model in GB.
   * Returns null if parameter count is unknown.
   *
   * Uses the most VRAM-efficient quantization available, with
   * a 20% overhead factor for KV cache and runtime buffers.
   *
   * @param model - The model to estimate VRAM for
   * @returns Estimated VRAM usage in GB, or null
   */
  estimateVramUsage(model: ModelInfo): number | null {
    if (!model.parameterCount) {
      return null;
    }

    // Find the most efficient quantization method
    const bytesPerParam = this.getBestBytesPerParam(model.quantizations);

    // Base model weight size in GB
    const modelWeightGb = (model.parameterCount * bytesPerParam) / (1024 * 1024 * 1024);

    // Add ~20% overhead for KV cache, activations, and runtime buffers
    const overheadFactor = 1.2;

    return Math.round(modelWeightGb * overheadFactor * 10) / 10;
  }

  // ─── Private Filter Methods ──────────────────────────────────────────────

  /**
   * Checks if the model's context window meets the minimum requirement.
   * This is a HARD requirement - models below 128K tokens are always rejected.
   */
  private checkContextSize(model: ModelInfo): FilterRejection | null {
    if (model.contextWindow >= this.minContextWindow) {
      return null;
    }

    return {
      criterion: 'context_size',
      reason: `Context window ${model.contextWindow.toLocaleString()} tokens is below the minimum requirement of ${this.minContextWindow.toLocaleString()} tokens`,
      isHardRequirement: true,
    };
  }

  /**
   * Checks if the model fits within the target hardware's VRAM.
   *
   * If the parameter count is unknown, returns a warning (not a hard rejection).
   * If the model exceeds VRAM, returns a hard rejection.
   */
  private checkModelSize(model: ModelInfo): FilterRejection | null {
    if (!model.parameterCount) {
      return {
        criterion: 'model_size',
        reason: 'Parameter count unknown; cannot verify VRAM fit. Proceeding with caution.',
        isHardRequirement: false,
      };
    }

    const totalVramGb = this.calculateTotalVram(this.targetHardware);
    const estimatedVramGb = this.estimateVramUsage(model);

    if (estimatedVramGb === null) {
      return null;
    }

    if (estimatedVramGb > totalVramGb) {
      return {
        criterion: 'model_size',
        reason: `Estimated VRAM usage ${estimatedVramGb}GB exceeds target hardware capacity of ${totalVramGb}GB (${this.targetHardware.gpuCount}x ${this.targetHardware.gpuType})`,
        isHardRequirement: true,
      };
    }

    return null;
  }

  /**
   * Checks if the model's architecture is supported by vLLM.
   */
  private checkVllmArchitecture(model: ModelInfo): FilterRejection | null {
    const arch = model.architecture.toLowerCase();

    // Direct match
    if (VLLM_SUPPORTED_ARCHITECTURES.has(arch)) {
      return null;
    }

    // Partial match for sub-architectures
    for (const supported of VLLM_SUPPORTED_ARCHITECTURES) {
      if (arch.includes(supported) || supported.includes(arch)) {
        return null;
      }
    }

    return {
      criterion: 'vllm_architecture',
      reason: `Architecture '${model.architecture}' is not supported by vLLM`,
      isHardRequirement: true,
    };
  }

  /**
   * Checks if the model supports tool calling via a known vLLM parser.
   *
   * Valid tool call parsers for vLLM:
   * - hermes: Qwen family models
   * - mistral: Mistral/Mixtral family models
   * - llama3_json: Llama 3 family models
   */
  private checkToolCalling(model: ModelInfo): FilterRejection | null {
    // First check: does the model claim tool calling support?
    if (!model.supportsToolCalling) {
      return {
        criterion: 'tool_calling',
        reason: 'Model does not support tool/function calling',
        isHardRequirement: true,
      };
    }

    // Second check: do we have a known vLLM parser for this model family?
    const parser = this.getRecommendedToolCallParser(model);
    if (!parser) {
      return {
        criterion: 'tool_calling',
        reason: `No known vLLM tool call parser for architecture '${model.architecture}'. Supported families: Qwen (hermes), Mistral/Mixtral (mistral), Llama (llama3_json)`,
        isHardRequirement: true,
      };
    }

    return null;
  }

  /**
   * Checks if the model is in the known failure list.
   * Supports exact matches and prefix patterns (ending with '*').
   */
  private checkKnownFailureList(model: ModelInfo): FilterRejection | null {
    // Exact match
    const exactReason = KNOWN_FAILURE_LIST.get(model.id);
    if (exactReason) {
      return {
        criterion: 'known_failure',
        reason: `Model is in the known failure list: ${exactReason}`,
        isHardRequirement: true,
      };
    }

    // Prefix pattern match
    for (const [pattern, reason] of KNOWN_FAILURE_LIST) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (model.id.startsWith(prefix)) {
          return {
            criterion: 'known_failure',
            reason: `Model matches known failure pattern '${pattern}': ${reason}`,
            isHardRequirement: true,
          };
        }
      }
    }

    return null;
  }

  // ─── Private Utility Methods ─────────────────────────────────────────────

  /**
   * Calculates total VRAM for a hardware profile in GB.
   */
  private calculateTotalVram(hardware: VMHardwareProfile): number {
    const gpuType = hardware.gpuType.toLowerCase();
    const perGpuVram = GPU_VRAM_GB[gpuType] ?? 0;

    if (perGpuVram === 0) {
      // Fallback: try to parse VRAM from GPU type name
      const vramMatch = gpuType.match(/(\d+)gb/);
      if (vramMatch?.[1]) {
        return parseInt(vramMatch[1], 10) * hardware.gpuCount;
      }
      this.logger.warn(`Unknown GPU type: ${hardware.gpuType}, cannot calculate VRAM`);
      return 0;
    }

    return perGpuVram * hardware.gpuCount;
  }

  /**
   * Determines the lowest bytes-per-parameter based on available quantizations.
   * Falls back to fp16 (2 bytes) if no quantization is recognized.
   */
  private getBestBytesPerParam(quantizations: string[]): number {
    let best = 2; // Default: fp16

    for (const quant of quantizations) {
      const normalized = quant.toLowerCase();
      const bytesPerParam = BYTES_PER_PARAM[normalized];
      if (bytesPerParam !== undefined && bytesPerParam < best) {
        best = bytesPerParam;
      }
    }

    return best;
  }
}
