/** Coarse pipeline stage for queue/dashboard progress. */
export type PipelineStage =
  | 'stage1_deploy'
  | 'stage1_health'
  | 'stage1_benchmark'
  | 'stage1_tool_call'
  | 'stage2_evals'
  | 'stage3_reasoning'
  | 'finalize';

export interface PipelineProgress {
  stage: PipelineStage;
  /** Human-readable sub-step (e.g. "Health check (29/180 attempts)"). */
  detail: string;
  /** Planned Stage 2 suite ids (matrix-critical set). */
  evalSuites?: string[];
  /** Suites finished (pass or fail). */
  evalCompleted?: string[];
  /** Suite currently running, if known. */
  evalCurrent?: string | null;
  evalTotal?: number;
  /** Optional numeric sub-progress within a stage (e.g. benchmark concurrency). */
  step?: number;
  stepTotal?: number;
  updatedAt: string;
}

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  stage1_deploy: 'Stage 1 — Deploy vLLM',
  stage1_health: 'Stage 1 — Health check',
  stage1_benchmark: 'Stage 1 — Performance benchmark',
  stage1_tool_call: 'Stage 1 — Tool-call gate',
  stage2_evals: 'Stage 2 — Security evals',
  stage3_reasoning: 'Stage 3 — Reasoning',
  finalize: 'Finalize report',
};

export const PIPELINE_STAGE_ORDER: PipelineStage[] = [
  'stage1_deploy',
  'stage1_health',
  'stage1_benchmark',
  'stage1_tool_call',
  'stage2_evals',
  'stage3_reasoning',
  'finalize',
];
