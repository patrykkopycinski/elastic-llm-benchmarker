/**
 * Information about a discovered HuggingFace model
 */
export interface ModelInfo {
  /** HuggingFace model ID (e.g., "meta-llama/Llama-3-70B") */
  id: string;
  /** Human-readable model name */
  name: string;
  /** Model architecture type */
  architecture: string;
  /** Maximum context window size in tokens */
  contextWindow: number;
  /** License type */
  license: string;
  /** Number of model parameters */
  parameterCount: number | null;
  /** Available quantization options */
  quantizations: string[];
  /** Whether the model supports tool/function calling */
  supportsToolCalling: boolean;
}

/**
 * Raw benchmark metrics from vllm bench serve
 */
export interface BenchmarkMetrics {
  /** Inter-Token Latency in milliseconds */
  itlMs: number;
  /** Time To First Token in milliseconds */
  ttftMs: number;
  /** Throughput in tokens per second */
  throughputTokensPerSec: number;
  /** P99 latency in milliseconds */
  p99LatencyMs: number;
  /** Concurrency level used for this benchmark */
  concurrencyLevel: number;
}

/**
 * Results for a single tool_choice mode (auto or required).
 */
export interface ToolCallModeResult {
  /** The tool_choice value used ("auto" or "required") */
  toolChoiceMode: 'auto' | 'required';
  /** Whether parallel tool calls are supported in this mode */
  supportsParallelCalls: boolean;
  /** Maximum number of concurrent tool calls observed */
  maxConcurrentCalls: number;
  /** Average tool call latency in milliseconds */
  avgToolCallLatencyMs: number;
  /** Tool call success rate (0-1) */
  successRate: number;
  /** Total number of tool call tests executed */
  totalTests: number;
}

/**
 * Tool calling test results.
 * Top-level fields reflect the best-case across modes for backward compatibility.
 * Per-mode breakdowns are in `modeResults` when available.
 */
export interface ToolCallResult {
  /** Whether parallel tool calls are supported (best across modes) */
  supportsParallelCalls: boolean;
  /** Maximum number of concurrent tool calls observed */
  maxConcurrentCalls: number;
  /** Average tool call latency in milliseconds */
  avgToolCallLatencyMs: number;
  /** Tool call success rate (0-1, best across modes) */
  successRate: number;
  /** Total number of tool call tests executed (sum across modes) */
  totalTests: number;
  /** Per-mode breakdown (auto vs required). May be absent for older results. */
  modeResults?: ToolCallModeResult[];
}

/**
 * GPU requirement estimate for running a model
 */
export interface GpuRequirement {
  /** Total model parameters in billions */
  parameterCountB: number;
  /** Estimated VRAM needed in GB (accounts for quantization + overhead) */
  estimatedVramGb: number;
  /** Human-readable GPU tier (e.g., "< 16 GB", "48–80 GB") */
  gpuCategory: string;
}

/**
 * Runtime GPU utilization metrics captured during model deployment.
 * Collected via nvidia-smi after the model is loaded and healthy.
 */
export interface GpuUtilization {
  /** VRAM used per GPU in GB (array, one entry per GPU) */
  vramUsedGb: number[];
  /** VRAM total per GPU in GB (array, one entry per GPU) */
  vramTotalGb: number[];
  /** Total VRAM used across all GPUs in GB */
  totalVramUsedGb: number;
  /** Total VRAM available across all GPUs in GB */
  totalVramTotalGb: number;
  /** VRAM utilization percentage (0-100) */
  vramUtilizationPct: number;
  /** GPU compute utilization percentage per GPU (0-100), if available */
  gpuUtilizationPct: number[] | null;
}

/**
 * Complete benchmark result for a single model
 */
export interface BenchmarkResult {
  /** HuggingFace model ID */
  modelId: string;
  /** Timestamp of the benchmark run */
  timestamp: string;
  /** vLLM version used */
  vllmVersion: string;
  /** Exact Docker command used for deployment */
  dockerCommand: string;
  /** Hardware configuration of the VM */
  hardwareConfig: {
    gpuType: string;
    gpuCount: number;
    ramGb: number;
    cpuCores: number;
    diskGb: number;
    machineType: string;
    /** ID of the hardware profile used, if any */
    hardwareProfileId: string | null;
  };
  /** Benchmark metrics at different concurrency levels */
  benchmarkMetrics: BenchmarkMetrics[];
  /** Tool calling test results */
  toolCallResults: ToolCallResult | null;
  /** Reasoning capability test results */
  reasoningResults?: import('./reasoning.js').ReasoningBenchmarkResult | null;
  /** Overall pass/fail status */
  passed: boolean;
  /** Reasons for rejection, if any */
  rejectionReasons: string[];
  /** Tensor parallel size used */
  tensorParallelSize: number;
  /** Tool call parser used (hermes/mistral/llama3_json) */
  toolCallParser: string;
  /** Raw benchmark output */
  rawOutput: string;
  /** Runtime GPU utilization metrics captured after deployment (optional, for backward compatibility) */
  gpuUtilization?: GpuUtilization | null;
}

// ─── Model Evaluation Types ──────────────────────────────────────────────────

/**
 * Classification outcome for a model evaluation.
 *
 * - APPROVED: Model meets ALL hard and preferred criteria
 * - CONDITIONAL: Model meets hard requirements but fails one or more preferred criteria
 * - REJECTED: Model fails one or more hard requirements
 */
export type EvaluationClassification = 'APPROVED' | 'CONDITIONAL' | 'REJECTED';

/**
 * Severity level of an evaluation criterion check.
 *
 * - HARD: Failing this criterion results in REJECTED status
 * - PREFERRED: Failing this criterion results in CONDITIONAL status (if all hard criteria pass)
 */
export type CriterionSeverity = 'HARD' | 'PREFERRED';

/**
 * Result of evaluating a single criterion against a model's benchmark data.
 */
export interface CriterionEvaluation {
  /** Identifier for the criterion (e.g., 'context_window', 'parallel_tool_calling') */
  criterion: string;
  /** Human-readable description of the criterion */
  description: string;
  /** Whether the criterion was met */
  passed: boolean;
  /** Severity level of this criterion */
  severity: CriterionSeverity;
  /** The actual measured value */
  actualValue: string;
  /** The required threshold value */
  requiredValue: string;
  /** Detailed message explaining the result */
  message: string;
}

/**
 * Complete evaluation report for a single model, including classification
 * and detailed criterion-by-criterion results.
 */
export interface ModelEvaluationReport {
  /** HuggingFace model ID */
  modelId: string;
  /** Timestamp of the evaluation */
  timestamp: string;
  /** Overall classification: APPROVED, CONDITIONAL, or REJECTED */
  classification: EvaluationClassification;
  /** Summary message describing the evaluation outcome */
  summary: string;
  /** Detailed results for each evaluation criterion */
  criteriaResults: CriterionEvaluation[];
  /** Criteria that failed (subset of criteriaResults where passed === false) */
  failedCriteria: CriterionEvaluation[];
  /** Number of criteria that passed */
  passedCount: number;
  /** Total number of criteria evaluated */
  totalCount: number;
  /** The benchmark result that was evaluated (null if report was created without full benchmark data) */
  benchmarkResult: BenchmarkResult | null;
  /** Model info if available */
  modelInfo: ModelInfo | null;
}
