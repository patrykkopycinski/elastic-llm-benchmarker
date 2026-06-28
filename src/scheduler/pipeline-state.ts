import type { TraceSummary } from '../services/trace-query-builder.js';
export type PipelineStage = 'idle' | 'hf_parse' | 'deploy' | 'benchmark' | 'store' | 'done' | 'failed';

export interface PipelineRun {
  runId: string;
  modelId: string;
  queueEntryId: string;
  stage: PipelineStage;
  startedAt: string;
  completedAt?: string;
  error?: string;
  // Populated during run
  hfCard?: HFCardResult;
  deployment?: DeploymentInfo;
  benchmarkResult?: Stage1Result;
  stage2Result?: Stage2Result;
  stage3Result?: Stage3Result;
}

export interface HFCardResult {
  modelId: string;
  architecture: string;
  contextLength: number;
  quantization: string[];
  tensorParallelSize: number;
  maxModelLen?: number;
  vllmFlags: string[];
  toolCallParser?: string;
  gpuMemoryRequired?: number;
  parsedFrom: { readme: boolean; configJson: boolean; generationConfigJson: boolean };
  warnings: string[];
}

export interface DeploymentInfo {
  deploymentName: string;
  containerId: string;
  endpointUrl: string;
  /** Public ngrok URL for Buildkite; set when tunnel succeeds */
  publicEndpointUrl?: string;
  status: 'deployed' | 'failed' | 'stopped';
}

export interface Stage1Result {
  runId: string;
  modelId: string;
  queueEntryId: string;
  status: 'success' | 'failed' | 'skipped';
  metrics: {
    itl_p50_ms: number;
    itl_p99_ms: number;
    ttft_ms: number;
    throughput_tps: number;
    duration_sec: number;
  } | null;
  rawOutput: string;
  error?: string;
  startedAt: string;
  completedAt: string;
  /** API endpoint URL of the deployed model (populated on success) */
  endpointUrl?: string;
  /** Container/deployment name for teardown (populated on success) */
  deploymentName?: string;
  /** Whether model meets stage2Thresholds (ITL, throughput, TTFT, context window). */
  stage2Eligible?: boolean;
}

export interface Stage2Result {
  runId: string;
  modelId: string;
  status: 'success' | 'skipped' | 'failed' | 'error';
  scores?: Record<string, number>;
  suiteResults?: Array<{ suite: string; status: string; score?: number; error?: string }>;
  tracesIndex?: string;
  reason?: string;
  startedAt: string;
  completedAt: string;
}

export interface Stage3Suggestion {
  category: 'config' | 'quantization' | 'hardware' | 'other';
  title: string;
  description: string;
  estimatedImpact: 'high' | 'medium' | 'low';
}

export interface Stage3Result {
  runId: string;
  modelId: string;
  status: 'success' | 'error';
  suggestions?: Stage3Suggestion[];
  traceSummary?: TraceSummary;
  rawResponse?: string;
  error?: string;
  startedAt: string;
  completedAt: string;
}
