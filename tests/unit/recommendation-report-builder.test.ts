import { describe, it, expect } from 'vitest';
import { buildRecommendationReport } from '../../src/services/recommendation-report-builder.js';
import type { PipelineRun, Stage1Result, Stage2Result, Stage3Result } from '../../src/scheduler/pipeline-state.js';
import type { AppConfig } from '../../src/types/config.js';
import { appConfigSchema } from '../../src/types/config.js';

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return appConfigSchema.parse({
    ssh: { host: 'test', username: 'test', password: 'test' },
    huggingfaceToken: 'hf_test',
    ...overrides,
  });
}

function makeRun(overrides?: Partial<PipelineRun>): PipelineRun {
  return {
    runId: 'run-123',
    modelId: 'Qwen/Qwen2.5-72B-Instruct',
    queueEntryId: 'q-1',
    stage: 'done',
    startedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function makeStage1(overrides?: Partial<Stage1Result>): Stage1Result {
  return {
    runId: 'run-123',
    modelId: 'Qwen/Qwen2.5-72B-Instruct',
    queueEntryId: 'q-1',
    status: 'success',
    metrics: {
      itl_p50_ms: 45,
      itl_p99_ms: 120,
      ttft_ms: 120,
      throughput_tps: 85,
      duration_sec: 300,
    },
    rawOutput: '',
    startedAt: '2026-06-01T00:00:00Z',
    completedAt: '2026-06-01T00:05:00Z',
    ...overrides,
  };
}

describe('buildRecommendationReport', () => {
  it('produces a reject verdict when stage 1 fails', () => {
    const config = makeConfig();
    const run = makeRun({
      benchmarkResult: makeStage1({ status: 'failed', error: 'OOM', metrics: null }),
    });

    const report = buildRecommendationReport(run, { config });

    expect(report.verdict).toBe('reject');
    expect(report.stage1Passed).toBe(false);
    expect(report.confidence).toBe('high');
    expect(report.blockingIssues.length).toBeGreaterThan(0);
    expect(report.modelId).toBe('Qwen/Qwen2.5-72B-Instruct');
    expect(report.modelName).toBe('Qwen2.5-72B-Instruct');
  });

  it('produces an investigate verdict when stage 1 passes but stage 2 did not run', () => {
    const config = makeConfig();
    const run = makeRun({
      benchmarkResult: makeStage1(),
    });

    const report = buildRecommendationReport(run, { config });

    expect(report.verdict).toBe('investigate');
    expect(report.stage1Passed).toBe(true);
    expect(report.stage2Ran).toBe(false);
    expect(report.confidence).toBe('low');
  });

  it('produces a support verdict when all stages pass with passing evals', () => {
    const config = makeConfig({ kibanaEval: { enabled: true, passThreshold: 80, globalTimeoutMs: 120000, continueOnCriticalFailure: false, testPrompt: 'test', expectedResponseKeywords: ['4'], toolCallTestToolName: 'get_time', toolCallTestPrompt: 'time?' } });
    const stage2: Stage2Result = {
      runId: 'run-123',
      modelId: 'Qwen/Qwen2.5-72B-Instruct',
      status: 'success',
      scores: { tool_calls: 0.94, skill_invocation: 0.91 },
      suiteResults: [
        { suite: 'tool_calls', status: 'passed', score: 0.94, durationMs: 120_000 },
        { suite: 'skill_invocation', status: 'passed', score: 0.91, durationMs: 90_000 },
      ],
      startedAt: '2026-06-01T00:05:00Z',
      completedAt: '2026-06-01T00:10:00Z',
    };
    const stage3: Stage3Result = {
      runId: 'run-123',
      modelId: 'Qwen/Qwen2.5-72B-Instruct',
      status: 'success',
      suggestions: [
        { category: 'config', title: 'Lower context', description: 'reduce max-model-len', estimatedImpact: 'high' },
      ],
      rawResponse: '{"suggestions":[]}',
      startedAt: '2026-06-01T00:10:00Z',
      completedAt: '2026-06-01T00:11:00Z',
    };

    const run = makeRun({
      benchmarkResult: makeStage1(),
      stage2Result: stage2,
      stage3Result: stage3,
    });

    const report = buildRecommendationReport(run, { config });

    expect(report.verdict).toBe('support');
    expect(report.confidence).toBe('high');
    expect(report.stage1Passed).toBe(true);
    expect(report.stage2Ran).toBe(true);
    expect(report.stage2Passed).toBe(true);
    expect(report.stage3Ran).toBe(true);
    expect(report.passingEvals).toHaveLength(2);
    expect(report.passingEvals.every(e => e.passed)).toBe(true);
    expect(report.stage2Results?.suiteResults['tool_calls']?.durationSec).toBe(120);
    expect(report.suggestions).toHaveLength(1);
    expect(report.reportId).toBeTruthy();
    expect(report.version).toBe(1);
  });

  it('produces an investigate verdict when some evals fail', () => {
    const config = makeConfig();
    const stage2: Stage2Result = {
      runId: 'run-123',
      modelId: 'Qwen/Qwen2.5-72B-Instruct',
      status: 'failed',
      suiteResults: [
        { suite: 'tool_calls', status: 'passed', score: 0.94 },
        { suite: 'skill_invocation', status: 'failed', score: 0.5 },
      ],
      startedAt: '2026-06-01T00:05:00Z',
      completedAt: '2026-06-01T00:10:00Z',
    };
    const run = makeRun({
      benchmarkResult: makeStage1(),
      stage2Result: stage2,
    });

    const report = buildRecommendationReport(run, { config });

    expect(report.verdict).toBe('investigate');
    expect(report.blockingIssues.some(i => i.category === 'eval')).toBe(true);
  });

  it('produces a reject verdict when stage 2 skipped due to gate failure', () => {
    const config = makeConfig();
    const stage2: Stage2Result = {
      runId: 'run-123',
      modelId: 'Qwen/Qwen2.5-72B-Instruct',
      status: 'skipped',
      reason: 'ITL p50 exceeds threshold',
      startedAt: '2026-06-01T00:05:00Z',
      completedAt: '2026-06-01T00:05:01Z',
    };
    const run = makeRun({
      benchmarkResult: makeStage1(),
      stage2Result: stage2,
    });

    const report = buildRecommendationReport(run, { config });

    expect(report.stage2Ran).toBe(false);
    expect(report.verdict).toBe('investigate');
    expect(report.blockingIssues.some(i => i.category === 'gate')).toBe(true);
  });

  it('fills vllm config from hfCard when present', () => {
    const config = makeConfig();
    const run = makeRun({
      benchmarkResult: makeStage1(),
      hfCard: {
        modelId: 'Qwen/Qwen2.5-72B-Instruct',
        architecture: 'qwen2',
        contextLength: 131072,
        quantization: ['awq'],
        tensorParallelSize: 4,
        vllmFlags: ['--max-model-len=131072', '--quantization=awq'],
        toolCallParser: 'hermes',
        parsedFrom: { readme: true, configJson: true, generationConfigJson: false },
        warnings: [],
      },
    });

    const report = buildRecommendationReport(run, { config });

    expect(report.vllmConfigUsed.contextLength).toBe(131072);
    expect(report.vllmConfigUsed.quantization).toBe('awq');
    expect(report.vllmConfigUsed.toolCallParser).toBe('hermes');
    expect(report.vllmConfigUsed.flags).toContain('--quantization=awq');
  });

  it('includes stage1 metrics when available', () => {
    const config = makeConfig();
    const run = makeRun({
      benchmarkResult: makeStage1({
        metrics: { itl_p50_ms: 42, itl_p99_ms: 110, ttft_ms: 95, throughput_tps: 90, duration_sec: 250 },
      }),
    });

    const report = buildRecommendationReport(run, { config });

    expect(report.stage1Metrics).not.toBeNull();
    expect(report.stage1Metrics!.itl.p50).toBe(42);
    expect(report.stage1Metrics!.throughputTps).toBe(90);
  });

  it('uses source parameter', () => {
    const config = makeConfig();
    const run = makeRun({ benchmarkResult: makeStage1() });
    const report = buildRecommendationReport(run, { config, source: 'discovery' });
    expect(report.source).toBe('discovery');
  });
});
