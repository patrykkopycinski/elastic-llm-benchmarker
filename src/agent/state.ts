import { Annotation } from '@langchain/langgraph';
import type { ModelInfo, BenchmarkResult } from '../types/benchmark.js';
import type { CircuitBreakerSnapshot } from '../services/circuit-breaker.js';
import type { ErrorCategory, RecoveryAction } from '../services/error-recovery.js';
import type { KibanaEvalReport } from '../types/kibana-eval.js';

/**
 * Record of a recovery attempt for audit/debugging purposes.
 */
export interface RecoveryRecord {
  /** Model ID that the recovery was for */
  modelId: string;
  /** Error category that triggered recovery */
  errorCategory: ErrorCategory;
  /** Recovery action that was taken */
  recoveryAction: RecoveryAction;
  /** Whether the recovery resulted in a successful retry */
  success: boolean;
  /** Attempt number */
  attemptNumber: number;
  /** Timestamp of the recovery attempt */
  timestamp: number;
  /** Human-readable message */
  message: string;
}

/**
 * LangGraph state annotation defining the agent's shared state schema.
 *
 * Each field uses a reducer to control how updates are merged.
 * - Primitive fields use "last write wins" semantics.
 * - Array fields use concat-based reducers so nodes can append items.
 */
export const AgentAnnotation = Annotation.Root({
  /**
   * Current state of the agent state machine.
   * Updated by each node to signal the active phase.
   */
  currentState: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => 'idle',
  }),

  /**
   * Models discovered from HuggingFace that match our criteria.
   * The discover node replaces the full list on each scan.
   */
  discoveredModels: Annotation<ModelInfo[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  /**
   * The model currently being evaluated / benchmarked.
   */
  currentModel: Annotation<ModelInfo | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Accumulated benchmark results across all models.
   * Uses a concat reducer so each benchmark run appends its result.
   */
  results: Annotation<BenchmarkResult[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  /**
   * Model IDs that have already been evaluated (to skip re-benchmarking).
   * Uses a concat reducer; nodes append newly evaluated IDs.
   */
  evaluatedModelIds: Annotation<string[]>({
    reducer: (prev, next) => [...new Set([...prev, ...next])],
    default: () => [],
  }),

  /**
   * Current error message (null when healthy).
   */
  error: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Number of consecutive errors encountered.
   * Reset to 0 on successful operations.
   */
  errorCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  /**
   * Timestamp (epoch ms) of the last successful operation.
   */
  lastSuccessTimestamp: Annotation<number | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Model IDs that have been skipped due to fatal errors (OOM, unsupported architecture, etc.).
   * These models will not be retried in the current session.
   * Uses a concat reducer with deduplication.
   */
  skippedModelIds: Annotation<string[]>({
    reducer: (prev, next) => [...new Set([...prev, ...next])],
    default: () => [],
  }),

  /**
   * Serialized circuit breaker state for persistence across agent runs.
   * Updated after each error handling decision.
   */
  circuitBreakerSnapshot: Annotation<CircuitBreakerSnapshot | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Recovery attempt records for audit and debugging.
   * Uses a concat reducer so each recovery attempt is appended.
   */
  recoveryRecords: Annotation<RecoveryRecord[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  /**
   * The error category of the last error, for routing decisions.
   */
  lastErrorCategory: Annotation<ErrorCategory | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Number of retry attempts for the current model.
   * Reset when moving to a new model.
   */
  currentModelRetryCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  /**
   * Public tunnel URL for the vLLM API, if a tunnel is active.
   * Set by the expose_api node when tunneling is enabled.
   * Used by the Kibana eval node for connector creation.
   */
  tunnelUrl: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * The Kibana connector ID for the current model, if one was created.
   * Set by the run_kibana_eval node when connector creation is enabled.
   * Null when connector creation is disabled or failed.
   */
  kibanaConnectorId: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * The latest Kibana evaluation report for the current model.
   * Set by the run_kibana_eval node after evaluation tasks complete.
   * Null when evaluation is disabled, skipped, or not yet run.
   */
  kibanaEvalReport: Annotation<KibanaEvalReport | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Accumulated Kibana evaluation reports across all models.
   * Uses a concat reducer so each evaluation appends its report.
   */
  kibanaEvalReports: Annotation<KibanaEvalReport[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

/**
 * Inferred state type from the annotation.
 */
export type GraphState = typeof AgentAnnotation.State;

/**
 * Inferred update type from the annotation (partial state for node returns).
 */
export type GraphStateUpdate = typeof AgentAnnotation.Update;
