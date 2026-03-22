import type {
  BenchmarkResult,
  ModelInfo,
  BenchmarkMetrics,
  EvaluationClassification,
  CriterionEvaluation,
  ModelEvaluationReport,
} from '../types/benchmark.js';
import type { BenchmarkThresholds } from '../types/config.js';
import { resolveMaxITLMs } from '../types/config.js';
import { getModelParamsBillions } from './gpu-requirements.js';
import { createLogger } from '../utils/logger.js';

// ─── Evaluation Engine Options ───────────────────────────────────────────────

/**
 * Configuration options for the model evaluation engine.
 * All thresholds have sensible defaults matching MODEL_EVALUATION_LOG criteria.
 */
export interface ModelEvaluationOptions {
  /** Minimum context window size in tokens (hard requirement, default: 128000) */
  minContextWindow?: number;
  /** Minimum parallel tool calling success rate (0-1) (hard requirement, default: 1.0) */
  minParallelToolCallSuccessRate?: number;
  /** Maximum acceptable inter-token latency in ms (preferred, default: 20). Ignored when benchmarkThresholds is set (tiered ITL used). */
  maxITLMs?: number;
  /** Maximum acceptable tool call latency in ms (preferred, default: 1000) */
  maxToolCallLatencyMs?: number;
  /** Full benchmark thresholds for tiered ITL by model size; when set, evaluateITL uses resolveMaxITLMs with model param count */
  benchmarkThresholds?: BenchmarkThresholds;
  /** Log level for the evaluation engine logger */
  logLevel?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MIN_CONTEXT_WINDOW = 128_000;
const DEFAULT_MIN_PARALLEL_TOOL_CALL_SUCCESS_RATE = 1.0;
const DEFAULT_MAX_ITL_MS = 20;
const DEFAULT_MAX_TOOL_CALL_LATENCY_MS = 1000;

// ─── Model Evaluation Engine ─────────────────────────────────────────────────

/**
 * Post-benchmark model evaluation engine that classifies models based on
 * performance data from benchmark runs.
 *
 * Applies evaluation criteria from MODEL_EVALUATION_LOG to produce one of
 * three classifications:
 *
 * - **APPROVED**: Model meets ALL criteria (hard and preferred)
 * - **CONDITIONAL**: Model meets all hard requirements but fails one or more preferred criteria
 * - **REJECTED**: Model fails at least one hard requirement
 *
 * ## Hard Requirements (REJECTED if failed)
 * - Context window >= 128K tokens
 * - Parallel tool calling success rate = 100%
 *
 * ## Preferred Criteria (CONDITIONAL if failed, hard requirements met)
 * - Inter-token latency (ITL) < 20ms
 * - Tool call latency < 1000ms
 *
 * @example
 * ```typescript
 * const engine = new ModelEvaluationEngine('info');
 * const report = engine.evaluate(benchmarkResult);
 *
 * if (report.classification === 'APPROVED') {
 *   console.log(`Model ${report.modelId} is fully approved!`);
 * } else if (report.classification === 'CONDITIONAL') {
 *   console.log(`Model approved with limitations: ${report.failedCriteria.map(c => c.message).join(', ')}`);
 * } else {
 *   console.log(`Model rejected: ${report.failedCriteria.map(c => c.message).join(', ')}`);
 * }
 * ```
 */
export class ModelEvaluationEngine {
  private readonly logger;
  private readonly minContextWindow: number;
  private readonly minParallelToolCallSuccessRate: number;
  private readonly maxITLMs: number;
  private readonly maxToolCallLatencyMs: number;
  private readonly benchmarkThresholds: BenchmarkThresholds | null;

  /**
   * Creates a new ModelEvaluationEngine instance.
   *
   * @param logLevel - Winston log level (default: 'info')
   * @param options - Evaluation threshold configuration
   */
  constructor(logLevel: string = 'info', options: ModelEvaluationOptions = {}) {
    this.logger = createLogger(logLevel);
    this.minContextWindow =
      options.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW;
    this.minParallelToolCallSuccessRate =
      options.minParallelToolCallSuccessRate ?? DEFAULT_MIN_PARALLEL_TOOL_CALL_SUCCESS_RATE;
    this.maxITLMs = options.maxITLMs ?? DEFAULT_MAX_ITL_MS;
    this.maxToolCallLatencyMs =
      options.maxToolCallLatencyMs ?? DEFAULT_MAX_TOOL_CALL_LATENCY_MS;
    this.benchmarkThresholds = options.benchmarkThresholds ?? null;

    this.logger.info('ModelEvaluationEngine initialized', {
      minContextWindow: this.minContextWindow,
      minParallelToolCallSuccessRate: this.minParallelToolCallSuccessRate,
      maxITLMs: this.maxITLMs,
      maxToolCallLatencyMs: this.maxToolCallLatencyMs,
      tieredITL: !!this.benchmarkThresholds,
    });
  }

  /**
   * Creates a ModelEvaluationEngine from the application's BenchmarkThresholds config.
   *
   * @param thresholds - BenchmarkThresholds from the app config
   * @param logLevel - Winston log level (default: 'info')
   * @returns Configured ModelEvaluationEngine instance
   */
  static fromConfig(
    thresholds: BenchmarkThresholds,
    logLevel: string = 'info',
  ): ModelEvaluationEngine {
    return new ModelEvaluationEngine(logLevel, {
      minContextWindow: thresholds.minContextWindow,
      minParallelToolCallSuccessRate: thresholds.minToolCallSuccessRate,
      maxITLMs: thresholds.maxITLMs,
      maxToolCallLatencyMs: thresholds.maxToolCallLatencyMs,
      benchmarkThresholds: thresholds,
    });
  }

  /**
   * Evaluates a benchmark result and produces a detailed evaluation report
   * with an APPROVED, CONDITIONAL, or REJECTED classification.
   *
   * @param benchmarkResult - The benchmark result to evaluate
   * @param modelInfo - Optional model info for additional context in the report
   * @returns Complete evaluation report with classification and criterion details
   */
  evaluate(
    benchmarkResult: BenchmarkResult,
    modelInfo: ModelInfo | null = null,
  ): ModelEvaluationReport {
    this.logger.info(`Evaluating model: ${benchmarkResult.modelId}`);

    const criteriaResults: CriterionEvaluation[] = [];

    // ── Hard Requirement: Context Window ──────────────────────────────
    criteriaResults.push(
      this.evaluateContextWindow(benchmarkResult, modelInfo),
    );

    // ── Hard Requirement: Parallel Tool Calling ──────────────────────
    criteriaResults.push(
      this.evaluateParallelToolCalling(benchmarkResult),
    );

    // ── Preferred: Inter-Token Latency ───────────────────────────────
    criteriaResults.push(this.evaluateITL(benchmarkResult));

    // ── Preferred: Tool Call Latency ─────────────────────────────────
    criteriaResults.push(this.evaluateToolCallLatency(benchmarkResult));

    // ── Derive Classification ────────────────────────────────────────
    const failedCriteria = criteriaResults.filter((c) => !c.passed);
    const passedCount = criteriaResults.filter((c) => c.passed).length;
    const totalCount = criteriaResults.length;

    const classification = this.deriveClassification(criteriaResults);
    const summary = this.generateSummary(
      benchmarkResult.modelId,
      classification,
      failedCriteria,
      passedCount,
      totalCount,
    );

    const report: ModelEvaluationReport = {
      modelId: benchmarkResult.modelId,
      timestamp: new Date().toISOString(),
      classification,
      summary,
      criteriaResults,
      failedCriteria,
      passedCount,
      totalCount,
      benchmarkResult,
      modelInfo,
    };

    this.logger.info(`Evaluation complete for ${benchmarkResult.modelId}`, {
      classification,
      passedCount,
      totalCount,
      failedCriteria: failedCriteria.map((c) => c.criterion),
    });

    return report;
  }

  /**
   * Evaluates a batch of benchmark results and produces reports for each.
   *
   * @param benchmarkResults - Array of benchmark results to evaluate
   * @param modelInfoMap - Optional map of model ID to ModelInfo for context
   * @returns Array of evaluation reports
   */
  evaluateBatch(
    benchmarkResults: BenchmarkResult[],
    modelInfoMap: Map<string, ModelInfo> = new Map(),
  ): ModelEvaluationReport[] {
    this.logger.info(`Evaluating batch of ${benchmarkResults.length} benchmark results`);

    const reports = benchmarkResults.map((result) => {
      const modelInfo = modelInfoMap.get(result.modelId) ?? null;
      return this.evaluate(result, modelInfo);
    });

    const approved = reports.filter((r) => r.classification === 'APPROVED').length;
    const conditional = reports.filter((r) => r.classification === 'CONDITIONAL').length;
    const rejected = reports.filter((r) => r.classification === 'REJECTED').length;

    this.logger.info(
      `Batch evaluation complete: ${approved} APPROVED, ${conditional} CONDITIONAL, ${rejected} REJECTED out of ${reports.length}`,
    );

    return reports;
  }

  /**
   * Generates a formatted text report for a model evaluation.
   *
   * @param report - The evaluation report to format
   * @returns Multi-line formatted text report
   */
  formatReport(report: ModelEvaluationReport): string {
    const lines: string[] = [];

    lines.push('═'.repeat(72));
    lines.push(`  MODEL EVALUATION REPORT`);
    lines.push('═'.repeat(72));
    lines.push('');
    lines.push(`  Model:          ${report.modelId}`);
    lines.push(`  Classification: ${report.classification}`);
    lines.push(`  Timestamp:      ${report.timestamp}`);
    lines.push(`  Score:          ${report.passedCount}/${report.totalCount} criteria passed`);
    lines.push('');
    lines.push('─'.repeat(72));
    lines.push(`  SUMMARY`);
    lines.push('─'.repeat(72));
    lines.push(`  ${report.summary}`);
    lines.push('');
    lines.push('─'.repeat(72));
    lines.push(`  CRITERIA DETAILS`);
    lines.push('─'.repeat(72));

    for (const criterion of report.criteriaResults) {
      const status = criterion.passed ? '✓ PASS' : '✗ FAIL';
      const severityTag = criterion.severity === 'HARD' ? '[HARD]' : '[PREF]';
      lines.push('');
      lines.push(`  ${status} ${severityTag} ${criterion.description}`);
      lines.push(`         Actual:   ${criterion.actualValue}`);
      lines.push(`         Required: ${criterion.requiredValue}`);
      if (!criterion.passed) {
        lines.push(`         → ${criterion.message}`);
      }
    }

    if (report.failedCriteria.length > 0) {
      lines.push('');
      lines.push('─'.repeat(72));
      lines.push(`  FAILED CRITERIA`);
      lines.push('─'.repeat(72));
      for (const failed of report.failedCriteria) {
        const severityTag = failed.severity === 'HARD' ? '[HARD]' : '[PREF]';
        lines.push(`  ${severityTag} ${failed.criterion}: ${failed.message}`);
      }
    }

    lines.push('');
    lines.push('═'.repeat(72));

    return lines.join('\n');
  }

  // ─── Private Criterion Evaluators ────────────────────────────────────────

  /**
   * Evaluates the context window criterion (HARD requirement).
   * Context window must be >= 128K tokens.
   *
   * Uses modelInfo.contextWindow when available, otherwise falls back to
   * checking the benchmark result metadata.
   */
  private evaluateContextWindow(
    benchmarkResult: BenchmarkResult,
    modelInfo: ModelInfo | null,
  ): CriterionEvaluation {
    // Use modelInfo context window if available
    const contextWindow = modelInfo?.contextWindow ?? null;

    if (contextWindow === null) {
      // If we have no context window data, we cannot evaluate this criterion.
      // Treat as failing since it's a hard requirement and we cannot verify.
      return {
        criterion: 'context_window',
        description: 'Context window >= 128K tokens',
        passed: false,
        severity: 'HARD',
        actualValue: 'unknown',
        requiredValue: `>= ${this.minContextWindow.toLocaleString()} tokens`,
        message: `Context window data not available for model ${benchmarkResult.modelId}. Cannot verify hard requirement.`,
      };
    }

    const passed = contextWindow >= this.minContextWindow;

    return {
      criterion: 'context_window',
      description: 'Context window >= 128K tokens',
      passed,
      severity: 'HARD',
      actualValue: `${contextWindow.toLocaleString()} tokens`,
      requiredValue: `>= ${this.minContextWindow.toLocaleString()} tokens`,
      message: passed
        ? `Context window ${contextWindow.toLocaleString()} tokens meets requirement`
        : `Context window ${contextWindow.toLocaleString()} tokens is below the minimum requirement of ${this.minContextWindow.toLocaleString()} tokens`,
    };
  }

  /**
   * Evaluates the parallel tool calling criterion (HARD requirement).
   * Parallel tool calling success rate must be 100%.
   */
  private evaluateParallelToolCalling(
    benchmarkResult: BenchmarkResult,
  ): CriterionEvaluation {
    const toolCallResults = benchmarkResult.toolCallResults;

    if (!toolCallResults) {
      return {
        criterion: 'parallel_tool_calling',
        description: 'Parallel tool calling success rate = 100%',
        passed: false,
        severity: 'HARD',
        actualValue: 'no tool call data',
        requiredValue: `success rate >= ${(this.minParallelToolCallSuccessRate * 100).toFixed(0)}%`,
        message: `No tool call benchmark data available for model ${benchmarkResult.modelId}. Cannot verify hard requirement.`,
      };
    }

    const successRate = toolCallResults.successRate;
    const passed =
      toolCallResults.supportsParallelCalls &&
      successRate >= this.minParallelToolCallSuccessRate;

    const actualDescription = toolCallResults.supportsParallelCalls
      ? `${(successRate * 100).toFixed(1)}% success rate (${toolCallResults.totalTests} tests, max ${toolCallResults.maxConcurrentCalls} concurrent)`
      : `Parallel calls not supported (success rate: ${(successRate * 100).toFixed(1)}%)`;

    return {
      criterion: 'parallel_tool_calling',
      description: 'Parallel tool calling success rate = 100%',
      passed,
      severity: 'HARD',
      actualValue: actualDescription,
      requiredValue: `success rate >= ${(this.minParallelToolCallSuccessRate * 100).toFixed(0)}%, parallel calls supported`,
      message: passed
        ? `Parallel tool calling meets requirement with ${(successRate * 100).toFixed(1)}% success rate`
        : toolCallResults.supportsParallelCalls
          ? `Parallel tool calling success rate ${(successRate * 100).toFixed(1)}% is below the required ${(this.minParallelToolCallSuccessRate * 100).toFixed(0)}%`
          : `Model does not support parallel tool calling`,
    };
  }

  /**
   * Evaluates the inter-token latency criterion (PREFERRED).
   * Uses tiered ITL threshold by model size when benchmarkThresholds is set.
   *
   * Uses the best (lowest concurrency) benchmark metrics for ITL evaluation.
   */
  private evaluateITL(benchmarkResult: BenchmarkResult): CriterionEvaluation {
    const metrics = this.getBestMetrics(benchmarkResult.benchmarkMetrics);

    const paramBillions = getModelParamsBillions(benchmarkResult.modelId);
    const maxITLMs = this.benchmarkThresholds
      ? resolveMaxITLMs(this.benchmarkThresholds, paramBillions)
      : this.maxITLMs;

    if (!metrics) {
      return {
        criterion: 'itl_latency',
        description: `Inter-token latency < ${maxITLMs}ms`,
        passed: false,
        severity: 'PREFERRED',
        actualValue: 'no benchmark data',
        requiredValue: `< ${maxITLMs}ms`,
        message: `No benchmark metrics available for model ${benchmarkResult.modelId}`,
      };
    }

    const itl = metrics.itlMs;
    const passed = itl < maxITLMs;

    return {
      criterion: 'itl_latency',
      description: `Inter-token latency < ${maxITLMs}ms`,
      passed,
      severity: 'PREFERRED',
      actualValue: `${itl.toFixed(2)}ms (at concurrency ${metrics.concurrencyLevel})`,
      requiredValue: `< ${maxITLMs}ms`,
      message: passed
        ? `ITL ${itl.toFixed(2)}ms meets preferred threshold`
        : `ITL ${itl.toFixed(2)}ms exceeds preferred threshold of ${maxITLMs}ms`,
    };
  }

  /**
   * Evaluates the tool call latency criterion (PREFERRED).
   * Average tool call latency should be < 1000ms.
   */
  private evaluateToolCallLatency(
    benchmarkResult: BenchmarkResult,
  ): CriterionEvaluation {
    const toolCallResults = benchmarkResult.toolCallResults;

    if (!toolCallResults) {
      return {
        criterion: 'tool_call_latency',
        description: `Tool call latency < ${this.maxToolCallLatencyMs}ms`,
        passed: false,
        severity: 'PREFERRED',
        actualValue: 'no tool call data',
        requiredValue: `< ${this.maxToolCallLatencyMs}ms`,
        message: `No tool call benchmark data available for model ${benchmarkResult.modelId}`,
      };
    }

    const latency = toolCallResults.avgToolCallLatencyMs;
    const passed = latency < this.maxToolCallLatencyMs;

    return {
      criterion: 'tool_call_latency',
      description: `Tool call latency < ${this.maxToolCallLatencyMs}ms`,
      passed,
      severity: 'PREFERRED',
      actualValue: `${latency.toFixed(2)}ms average`,
      requiredValue: `< ${this.maxToolCallLatencyMs}ms`,
      message: passed
        ? `Tool call latency ${latency.toFixed(2)}ms meets preferred threshold`
        : `Tool call latency ${latency.toFixed(2)}ms exceeds preferred threshold of ${this.maxToolCallLatencyMs}ms`,
    };
  }

  // ─── Private Utility Methods ─────────────────────────────────────────────

  /**
   * Derives the final classification from criterion evaluation results.
   *
   * Logic:
   * - If ANY hard requirement fails → REJECTED
   * - If all hard requirements pass but ANY preferred criteria fails → CONDITIONAL
   * - If ALL criteria pass → APPROVED
   */
  private deriveClassification(
    criteria: CriterionEvaluation[],
  ): EvaluationClassification {
    const hasHardFailure = criteria.some(
      (c) => !c.passed && c.severity === 'HARD',
    );

    if (hasHardFailure) {
      return 'REJECTED';
    }

    const hasPreferredFailure = criteria.some(
      (c) => !c.passed && c.severity === 'PREFERRED',
    );

    if (hasPreferredFailure) {
      return 'CONDITIONAL';
    }

    return 'APPROVED';
  }

  /**
   * Generates a human-readable summary message for the evaluation.
   */
  private generateSummary(
    modelId: string,
    classification: EvaluationClassification,
    failedCriteria: CriterionEvaluation[],
    passedCount: number,
    totalCount: number,
  ): string {
    switch (classification) {
      case 'APPROVED':
        return `Model ${modelId} is APPROVED. All ${totalCount} evaluation criteria met successfully.`;

      case 'CONDITIONAL': {
        const failedPreferred = failedCriteria.filter(
          (c) => c.severity === 'PREFERRED',
        );
        const limitations = failedPreferred
          .map((c) => c.criterion)
          .join(', ');
        return `Model ${modelId} is CONDITIONALLY APPROVED. Meets all hard requirements but has limitations: ${limitations}. (${passedCount}/${totalCount} criteria passed)`;
      }

      case 'REJECTED': {
        const failedHard = failedCriteria.filter(
          (c) => c.severity === 'HARD',
        );
        const reasons = failedHard.map((c) => c.criterion).join(', ');
        return `Model ${modelId} is REJECTED. Failed hard requirements: ${reasons}. (${passedCount}/${totalCount} criteria passed)`;
      }
    }
  }

  /**
   * Returns the benchmark metrics at the lowest concurrency level.
   * This gives the best (most favorable) latency numbers for the model.
   *
   * @param metrics - Array of benchmark metrics at different concurrency levels
   * @returns The metrics with the lowest concurrency level, or null if empty
   */
  private getBestMetrics(
    metrics: BenchmarkMetrics[],
  ): BenchmarkMetrics | null {
    if (metrics.length === 0) {
      return null;
    }

    return metrics.reduce((best, current) =>
      current.concurrencyLevel < best.concurrencyLevel ? current : best,
    );
  }
}
