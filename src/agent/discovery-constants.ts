// src/agent/discovery-constants.ts
/**
 * Model discovery and scoring constants
 */

/**
 * Maximum number of models to evaluate during discovery phase.
 * Balances thoroughness (want to find good models) vs speed (don't want discovery to take forever).
 */
export const MAX_MODELS_TO_EVALUATE = 20;

/**
 * Number of top-scoring models to queue for benchmarking.
 * Prevents queue flooding while ensuring high-quality candidates get evaluated.
 */
export const TOP_MODELS_TO_QUEUE = 5;

/**
 * Scoring weights for model ranking (out of 100 total possible).
 * Higher scores indicate better candidates for benchmarking.
 */
export const SCORING_WEIGHTS = {
  /** Tool calling support (0-30 points) */
  TOOL_CALLING: 30,

  /** Reasoning support (0-40 points) */
  REASONING: 40,

  /** Community engagement: 1 point per 1000 likes (0-∞ points) */
  LIKES_DIVISOR: 1000,

  /** Adoption metric: 1 point per 10000 downloads (0-∞ points) */
  DOWNLOADS_DIVISOR: 10000,
} as const;

/**
 * Polling configuration for interactive benchmark waiting
 */
export const POLLING_CONFIG = {
  /** Initial poll interval in milliseconds */
  POLL_INTERVAL_MS: 5000, // 5 seconds

  /** Maximum wait time before timeout */
  MAX_WAIT_MS: 3600000, // 1 hour

  /** Maximum poll interval (for exponential backoff) */
  MAX_POLL_INTERVAL_MS: 30000, // 30 seconds

  /** Backoff multiplier for exponential backoff */
  BACKOFF_MULTIPLIER: 1.5,
} as const;

/**
 * Concurrency limits for discovery operations
 */
export const DISCOVERY_CONCURRENCY = {
  /** Maximum concurrent model evaluations */
  MAX_CONCURRENT_EVALUATIONS: 5,

  /** Maximum concurrent API requests */
  MAX_CONCURRENT_API_CALLS: 10,
} as const;
