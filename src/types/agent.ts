import type { ModelInfo, BenchmarkResult } from './benchmark.js';

/**
 * Possible states of the LangGraph agent
 */
export type AgentStateKey =
  | 'idle'
  | 'discovering_models'
  | 'evaluating_model'
  | 'deploying_model'
  | 'health_checking'
  | 'running_benchmark'
  | 'running_tool_call_test'
  | 'storing_results'
  | 'exposing_api'
  | 'running_kibana_eval'
  | 'error';

/**
 * Agent state definition for the LangGraph state machine
 */
export interface AgentState {
  /** Current state of the agent */
  currentState: AgentStateKey;
  /** Models discovered from HuggingFace */
  discoveredModels: ModelInfo[];
  /** Model currently being evaluated */
  currentModel: ModelInfo | null;
  /** Accumulated benchmark results */
  results: BenchmarkResult[];
  /** Models that have already been evaluated (to avoid re-benchmarking) */
  evaluatedModelIds: string[];
  /** Current error message, if any */
  error: string | null;
  /** Number of consecutive errors */
  errorCount: number;
  /** Timestamp of the last successful operation */
  lastSuccessTimestamp: number | null;
}

/**
 * Initial/default agent state
 */
export const initialAgentState: AgentState = {
  currentState: 'idle',
  discoveredModels: [],
  currentModel: null,
  results: [],
  evaluatedModelIds: [],
  error: null,
  errorCount: 0,
  lastSuccessTimestamp: null,
};
