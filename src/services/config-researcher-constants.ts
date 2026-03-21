// src/services/config-researcher-constants.ts
/**
 * Configuration research constants
 */

/**
 * Estimated GB of VRAM needed per billion parameters when using tensor parallelism.
 * Based on A100 80GB empirical data: ~35GB per GPU for 70B models with TP=2.
 */
export const GB_PER_GPU_FOR_TENSOR_PARALLEL = 35;

/**
 * Default context window when HF API unavailable
 */
export const DEFAULT_CONTEXT_WINDOW = 8192;

/**
 * Reasoning capability detection keywords
 * Uses word boundaries to avoid false positives
 */
export const REASONING_KEYWORDS = {
  patterns: [
    /\breasoning\b/i,     // "reasoning" as whole word
    /[-_]r1[-_]/i,        // "deepseek-r1", "model-r1-base"
    /[-_]o1[-_]/i,        // "gpt-o1", "model-o1-preview"
    /deepseek-r\d+/i,     // "deepseek-r1", "deepseek-r2"
    /\bqwq\b/i,           // "QwQ" as whole word
    /extended-thinking/i, // Specific reasoning indicator
  ],
  description: 'Patterns to detect reasoning-capable models from model ID',
};
