import type { PipelineRun } from '../scheduler/pipeline-state.js';
import type { AppConfig } from '../types/config.js';
import { resolveMaxItlP50Ms } from '../types/config.js';
import { getModelParamsBillions } from './gpu-requirements.js';
import type {
  RecommendationReport,
  Verdict,
  Confidence,
  EvalScore,
  BlockingIssue,
  ReportSuggestion,
  Stage1Metrics,
  Stage2Results,
  VllmConfigUsed,
} from '../types/recommendation.js';

const VERSION = '0.1.0';

export interface ReportBuilderOptions {
  config: AppConfig;
  source?: 'discovery' | 'manual';
}

export function buildRecommendationReport(
  run: PipelineRun,
  options: ReportBuilderOptions,
): RecommendationReport {
  const { config, source = 'manual' } = options;
  const stage1 = run.benchmarkResult;
  const stage2 = run.stage2Result;
  const stage3 = run.stage3Result;

  const stage1Passed = stage1?.status === 'success';
  const stage2Ran = stage2 !== undefined && stage2.status !== 'skipped';
  const stage2Passed = stage2Ran ? stage2!.status === 'success' : null;
  const stage3Ran = stage3 !== undefined;

  const blockingIssues: BlockingIssue[] = [];
  const passingEvals: EvalScore[] = [];

  let stage1Metrics: Stage1Metrics | null = null;
  if (stage1?.metrics) {
    const m = stage1.metrics;
    stage1Metrics = {
      itl: { p50: m.itl_p50_ms, p99: m.itl_p99_ms, mean: m.itl_p50_ms },
      ttft: { p50: m.ttft_ms, p99: m.ttft_ms, mean: m.ttft_ms },
      throughputTps: m.throughput_tps,
    };
  }

  if (!stage1Passed && stage1?.error) {
    blockingIssues.push({
      severity: 'critical',
      category: 'stage1',
      message: stage1.error,
    });
  }

  if (!stage1Passed && stage1?.metrics) {
    const m = stage1.metrics;
    const thresholds = config.stage2Thresholds;
    const maxItlP50Ms = resolveMaxItlP50Ms(
      thresholds,
      stage1?.parameterCountBillions ?? getModelParamsBillions(run.modelId),
    );
    if (m.itl_p50_ms > maxItlP50Ms) {
      blockingIssues.push({
        severity: 'critical',
        category: 'performance',
        message: `ITL p50 (${m.itl_p50_ms}ms) exceeds threshold (${maxItlP50Ms}ms)`,
      });
    }
    if (m.throughput_tps < thresholds.minThroughputTps) {
      blockingIssues.push({
        severity: 'critical',
        category: 'throughput',
        message: `Throughput (${m.throughput_tps} tps) below threshold (${thresholds.minThroughputTps} tps)`,
      });
    }
  }

  let stage2Results: Stage2Results | null = null;
  if (stage2Ran && stage2?.suiteResults) {
    const suitesRun = stage2.suiteResults.map((sr) => sr.suite);
    const suiteResults: Record<string, { score: number; passRate: number; durationSec: number }> = {};
    for (const sr of stage2.suiteResults) {
      suiteResults[sr.suite] = {
        score: sr.score ?? 0,
        passRate: sr.score ?? 0,
        durationSec: 0,
      };

      const threshold = config.kibanaEval.passThreshold / 100;
      const score = sr.score ?? 0;
      const passed = score >= threshold;

      passingEvals.push({
        suite: sr.suite,
        score,
        threshold,
        passed,
      });

      if (!passed) {
        blockingIssues.push({
          severity: 'warning',
          category: 'eval',
          message: `Eval suite "${sr.suite}" score (${score}) below threshold (${threshold})`,
        });
      }
    }
    stage2Results = { suitesRun, suiteResults };
  }

  if (stage2?.status === 'skipped' && stage2.reason) {
    blockingIssues.push({
      severity: 'info',
      category: 'gate',
      message: `Stage 2 skipped: ${stage2.reason}`,
    });
  }

  const suggestions: ReportSuggestion[] = [];
  if (stage3?.suggestions) {
    for (const s of stage3.suggestions) {
      suggestions.push({
        category: s.category,
        title: s.title,
        description: s.description,
        expectedImpact: s.description,
        confidence: s.estimatedImpact === 'high' ? 'high' : s.estimatedImpact === 'low' ? 'low' : 'medium',
      });
    }
  }

  const verdict = computeVerdict(stage1Passed, stage2Passed, stage2Ran, passingEvals);
  const confidence = computeConfidence(stage1Passed, stage2Ran, stage3Ran, passingEvals);

  const vllmConfigUsed: VllmConfigUsed = {
    contextLength: run.hfCard?.contextLength,
    quantization: run.hfCard?.quantization?.[0],
    toolCallParser: run.hfCard?.toolCallParser,
    flags: run.hfCard?.vllmFlags ?? [],
    source: 'model_card',
  };

  const reasoningSummary = stage3?.rawResponse
    ? stage3.rawResponse.slice(0, 500)
    : null;

  const modelName = run.modelId.includes('/') ? run.modelId.split('/').pop()! : run.modelId;

  return {
    reportId: crypto.randomUUID(),
    modelId: run.modelId,
    modelName,
    verdict,
    confidence,
    hardwareProfile: config.hardwareProfileId ?? `${config.vmHardwareProfile.gpuType}x${config.vmHardwareProfile.gpuCount}`,
    stage1Passed,
    stage2Passed,
    stage2Ran,
    stage3Ran,
    passingEvals,
    blockingIssues,
    vllmConfigUsed,
    suggestions,
    stage1Metrics,
    stage2Results,
    reasoningSummary,
    runId: run.runId,
    version: 1,
    evaluatedAt: new Date().toISOString(),
    evaluatedBy: `benchmarker-v${VERSION}`,
    source,
  };
}

function computeVerdict(
  stage1Passed: boolean,
  stage2Passed: boolean | null,
  stage2Ran: boolean,
  passingEvals: EvalScore[],
): Verdict {
  if (!stage1Passed) return 'reject';
  if (!stage2Ran) return 'investigate';
  if (stage2Passed === false) {
    const allFailed = passingEvals.every((e) => !e.passed);
    return allFailed ? 'reject' : 'investigate';
  }
  const allEvalsPassed = passingEvals.length > 0 && passingEvals.every((e) => e.passed);
  return allEvalsPassed ? 'support' : 'investigate';
}

function computeConfidence(
  stage1Passed: boolean,
  stage2Ran: boolean,
  stage3Ran: boolean,
  passingEvals: EvalScore[],
): Confidence {
  if (!stage1Passed) return 'high';
  if (!stage2Ran) return 'low';
  if (!stage3Ran) return 'medium';
  const allEvalsPassed = passingEvals.length > 0 && passingEvals.every((e) => e.passed);
  return allEvalsPassed ? 'high' : 'medium';
}
