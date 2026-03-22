/**
 * Types for the Kibana Agent Builder evaluation framework.
 *
 * Defines evaluation tasks, success criteria, scoring methodology,
 * and result structures for testing models via Kibana's Agent builder features.
 */

// ─── Evaluation Task Types ──────────────────────────────────────────────────

/**
 * Category of evaluation task targeting specific Kibana Agent builder capabilities.
 */
export type KibanaEvalTaskCategory =
  | 'connector_health'
  | 'chat_completion'
  | 'tool_calling'
  | 'streaming'
  | 'error_handling';

/**
 * Severity of an evaluation task — determines impact on overall scoring.
 *
 * - CRITICAL: Failing blocks usage entirely (weight: 1.0)
 * - IMPORTANT: Significant impact on usability (weight: 0.7)
 * - NICE_TO_HAVE: Marginal impact (weight: 0.3)
 */
export type KibanaEvalTaskSeverity = 'CRITICAL' | 'IMPORTANT' | 'NICE_TO_HAVE';

/**
 * Outcome of a single evaluation task execution.
 */
export type KibanaEvalTaskOutcome = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';

/**
 * Definition of a single evaluation task to run against the Kibana connector.
 */
export interface KibanaEvalTaskDefinition {
  /** Unique task identifier (e.g., 'connector_health_check') */
  id: string;
  /** Human-readable task name */
  name: string;
  /** Detailed description of what the task verifies */
  description: string;
  /** Category of the evaluation task */
  category: KibanaEvalTaskCategory;
  /** Severity level determining scoring weight */
  severity: KibanaEvalTaskSeverity;
  /** Maximum time in milliseconds allowed for this task */
  timeoutMs: number;
  /** Number of retry attempts before marking as failed */
  retryAttempts: number;
}

/**
 * Result of executing a single evaluation task.
 */
export interface KibanaEvalTaskResult {
  /** Task definition that was executed */
  task: KibanaEvalTaskDefinition;
  /** Outcome of the task execution */
  outcome: KibanaEvalTaskOutcome;
  /** Duration of the task execution in milliseconds */
  durationMs: number;
  /** Human-readable message describing the result */
  message: string;
  /** Detailed error information if the task failed or errored */
  error: string | null;
  /** Numeric score for this task (0.0 - 1.0) */
  score: number;
  /** Weighted score (score * severity weight) */
  weightedScore: number;
  /** Number of attempts made */
  attempts: number;
  /** Response metadata from the Kibana API (status code, latency, etc.) */
  metadata: Record<string, unknown>;
}

// ─── Scoring Types ──────────────────────────────────────────────────────────

/**
 * Overall evaluation classification derived from task scores.
 *
 * - PASS: All critical tasks pass and weighted score >= passThreshold
 * - PARTIAL: All critical tasks pass but score < passThreshold
 * - FAIL: One or more critical tasks failed
 */
export type KibanaEvalClassification = 'PASS' | 'PARTIAL' | 'FAIL';

/**
 * Scoring breakdown for the evaluation.
 */
export interface KibanaEvalScoring {
  /** Total raw score across all tasks (sum of individual scores) */
  totalScore: number;
  /** Maximum possible score (sum of all task max scores) */
  maxScore: number;
  /** Total weighted score (sum of weighted scores) */
  totalWeightedScore: number;
  /** Maximum possible weighted score */
  maxWeightedScore: number;
  /** Normalized percentage score (0-100) */
  percentageScore: number;
  /** Number of tasks that passed */
  passedCount: number;
  /** Number of tasks that failed */
  failedCount: number;
  /** Number of tasks that were skipped */
  skippedCount: number;
  /** Number of tasks that errored */
  erroredCount: number;
  /** Total number of tasks */
  totalCount: number;
}

/**
 * Severity weight mapping for scoring calculations.
 */
export const SEVERITY_WEIGHTS: Record<KibanaEvalTaskSeverity, number> = {
  CRITICAL: 1.0,
  IMPORTANT: 0.7,
  NICE_TO_HAVE: 0.3,
};

// ─── Evaluation Report Types ────────────────────────────────────────────────

/**
 * Complete evaluation report for a model's Kibana Agent builder capabilities.
 */
export interface KibanaEvalReport {
  /** HuggingFace model ID that was evaluated */
  modelId: string;
  /** Kibana connector ID used for evaluation */
  connectorId: string;
  /** Timestamp of the evaluation (ISO 8601) */
  timestamp: string;
  /** Overall evaluation classification */
  classification: KibanaEvalClassification;
  /** Human-readable summary of the evaluation outcome */
  summary: string;
  /** Scoring breakdown */
  scoring: KibanaEvalScoring;
  /** Individual task results */
  taskResults: KibanaEvalTaskResult[];
  /** Tasks that failed (subset of taskResults) */
  failedTasks: KibanaEvalTaskResult[];
  /** Duration of the entire evaluation in milliseconds */
  totalDurationMs: number;
  /** Configuration used for this evaluation */
  evalConfig: KibanaEvalRunnerConfig;
}

// ─── Configuration Types ────────────────────────────────────────────────────

/**
 * Configuration for the Kibana evaluation runner.
 */
export interface KibanaEvalRunnerConfig {
  /** Whether the evaluation runner is enabled. Defaults to true when Kibana connector is enabled. */
  enabled: boolean;
  /** Score threshold (0-100) for PASS classification. Defaults to 80. */
  passThreshold: number;
  /** Global timeout for the entire evaluation in milliseconds. Defaults to 120000 (2 min). */
  globalTimeoutMs: number;
  /** Whether to continue running remaining tasks after a critical failure. Defaults to false. */
  continueOnCriticalFailure: boolean;
  /** Test prompt to use for chat completion evaluation. */
  testPrompt: string;
  /** Expected keywords in chat completion response for basic validation. */
  expectedResponseKeywords: string[];
  /** Tool name for tool calling evaluation. */
  toolCallTestToolName: string;
  /** Tool prompt for tool calling evaluation. */
  toolCallTestPrompt: string;
}

/**
 * Default configuration for the Kibana evaluation runner.
 */
export const DEFAULT_KIBANA_EVAL_CONFIG: KibanaEvalRunnerConfig = {
  enabled: true,
  passThreshold: 80,
  globalTimeoutMs: 120_000,
  continueOnCriticalFailure: false,
  testPrompt: 'What is 2 + 2? Answer with just the number.',
  expectedResponseKeywords: ['4'],
  toolCallTestToolName: 'get_current_time',
  toolCallTestPrompt: 'What is the current time? Use the get_current_time tool.',
};
