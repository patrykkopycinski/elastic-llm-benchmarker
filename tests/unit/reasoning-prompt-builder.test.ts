import { describe, it, expect } from 'vitest';
import { ReasoningPromptBuilderImpl } from '../../src/services/reasoning-prompt-builder.js';
import type { PipelineRun, HFCardResult, Stage1Result, Stage2Result } from '../../src/scheduler/pipeline-state.js';
import type { TraceSummary } from '../../src/services/trace-query-builder.js';

function createPipelineRun(overrides?: Partial<PipelineRun>): PipelineRun {
  return {
    runId: 'run-1',
    modelId: 'org/model-1',
    queueEntryId: 'q1',
    stage: 'done',
    startedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function createHFCardResult(overrides?: Partial<HFCardResult>): HFCardResult {
  return {
    modelId: 'org/model-1',
    architecture: 'transformer',
    contextLength: 4096,
    quantization: ['fp16', 'q4_k_m'],
    tensorParallelSize: 1,
    maxModelLen: 4096,
    vllmFlags: ['--enable-chunked-prefill', '--max-num-batched-tokens=4096'],
    gpuMemoryRequired: 24,
    parsedFrom: { readme: true, configJson: true, generationConfigJson: false },
    warnings: [],
    ...overrides,
  };
}

function createStage1Result(overrides?: Partial<Stage1Result>): Stage1Result {
  return {
    runId: 'run-1',
    modelId: 'org/model-1',
    queueEntryId: 'q1',
    status: 'success',
    metrics: {
      itl_p50_ms: 12.5,
      itl_p99_ms: 45.2,
      ttft_ms: 120,
      throughput_tps: 85.3,
      duration_sec: 300,
    },
    rawOutput: 'benchmark raw output here',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:05:00Z',
    ...overrides,
  };
}

function createStage2Result(overrides?: Partial<Stage2Result>): Stage2Result {
  return {
    runId: 'run-1',
    modelId: 'org/model-1',
    status: 'success',
    scores: { overall: 0.85, tool_use: 0.9, reasoning: 0.8 },
    suiteResults: [
      { suite: 'tool_call', status: 'success', score: 0.9 },
      { suite: 'math', status: 'failed', score: 0.6, error: 'timeout' },
    ],
    tracesIndex: '.benchmark-traces-run-1',
    reason: 'Completed successfully',
    startedAt: '2026-01-01T00:05:00Z',
    completedAt: '2026-01-01T00:10:00Z',
    ...overrides,
  };
}

function createTraceSummary(overrides?: Partial<TraceSummary>): TraceSummary {
  return {
    totalSpans: 150,
    errorCount: 3,
    topErrors: [
      { operation: 'infer', count: 2, sampleMessage: ' CUDA out of memory' },
      { operation: 'deploy', count: 1, sampleMessage: 'health check timeout' },
    ],
    latencyPercentiles: { p50_ms: 15.2, p95_ms: 42.8, p99_ms: 89.1 },
    operations: [
      { name: 'infer', count: 100, avgDurationMs: 20.5, errorRate: 0.02 },
      { name: 'deploy', count: 20, avgDurationMs: 1200, errorRate: 0.05 },
      { name: 'health_check', count: 30, avgDurationMs: 5.2, errorRate: 0 },
    ],
    ...overrides,
  };
}

describe('ReasoningPromptBuilderImpl', () => {
  const builder = new ReasoningPromptBuilderImpl();

  it('generates full prompt with all data present', () => {
    const prompt = builder.build({
      pipelineRun: createPipelineRun(),
      vllmConfig: createHFCardResult(),
      stage1Result: createStage1Result(),
      stage2Result: createStage2Result(),
      traceSummary: createTraceSummary(),
    });

    expect(prompt).toContain('org/model-1');
    expect(prompt).toContain('transformer');
    expect(prompt).toContain('4096');
    expect(prompt).toContain('fp16');
    expect(prompt).toContain('--enable-chunked-prefill');
    expect(prompt).toContain('12.5');
    expect(prompt).toContain('85.3');
    expect(prompt).toContain('overall: 0.85');
    expect(prompt).toContain('tool_call: success');
    expect(prompt).toContain('math: failed');
    expect(prompt).toContain('1 passed, 1 failed');
    expect(prompt).toContain('Completed successfully');
    expect(prompt).toContain('Total spans: 150');
    expect(prompt).toContain('CUDA out of memory');
    expect(prompt).toContain('p50: 15.20 ms');
    expect(prompt).toContain('infer: count=100');
    expect(prompt).toContain('You are a vLLM performance optimization expert');
    expect(prompt).toContain('"suggestions"');
  });

  it('outputs "Stage 2 was not run" when stage2Result is undefined', () => {
    const prompt = builder.build({
      pipelineRun: createPipelineRun(),
      vllmConfig: createHFCardResult(),
      stage1Result: createStage1Result(),
      stage2Result: undefined,
      traceSummary: createTraceSummary(),
    });

    expect(prompt).toContain('Stage 2 was not run');
  });

  it('handles missing stage1Result gracefully', () => {
    const prompt = builder.build({
      pipelineRun: createPipelineRun(),
      vllmConfig: createHFCardResult(),
      stage1Result: undefined,
      stage2Result: createStage2Result(),
      traceSummary: createTraceSummary(),
    });

    expect(prompt).toContain('No Stage 1 benchmark results available');
    expect(prompt).not.toContain('ITL p50');
  });

  it('uses placeholder text when hfCard is missing', () => {
    const prompt = builder.build({
      pipelineRun: createPipelineRun(),
      vllmConfig: undefined,
      stage1Result: createStage1Result(),
      stage2Result: createStage2Result(),
      traceSummary: createTraceSummary(),
    });

    expect(prompt).toContain('Architecture: Unknown');
    expect(prompt).toContain('Context Length: Unknown');
    expect(prompt).toContain('Quantization: Unknown');
    expect(prompt).toContain('Tensor Parallel: Unknown');
    expect(prompt).toContain('GPU Memory Required: Unknown GB');
    expect(prompt).toContain('Flags used: None');
  });

  it('does not exceed 32,000 characters with large inputs', () => {
    const largeRawOutput = 'x'.repeat(100_000);
    const manyOps = Array.from({ length: 100 }, (_, i) => ({
      name: `op-${i}`,
      count: i + 1,
      avgDurationMs: i * 1.5,
      errorRate: i / 200,
    }));
    const manyErrors = Array.from({ length: 50 }, (_, i) => ({
      operation: `err-${i}`,
      count: i + 1,
      sampleMessage: 'error message '.repeat(20),
    }));

    const prompt = builder.build({
      pipelineRun: createPipelineRun(),
      vllmConfig: createHFCardResult(),
      stage1Result: createStage1Result({ rawOutput: largeRawOutput }),
      stage2Result: createStage2Result({
        suiteResults: Array.from({ length: 100 }, (_, i) => ({
          suite: `suite-${i}`,
          status: i % 2 === 0 ? 'success' : 'failed',
          score: i / 100,
        })),
      }),
      traceSummary: createTraceSummary({
        operations: manyOps,
        topErrors: manyErrors,
      }),
    });

    expect(prompt.length).toBeLessThanOrEqual(32_000);
  });

  it('includes all required section headers', () => {
    const prompt = builder.build({
      pipelineRun: createPipelineRun(),
      vllmConfig: createHFCardResult(),
      stage1Result: createStage1Result(),
      stage2Result: createStage2Result(),
      traceSummary: createTraceSummary(),
    });

    expect(prompt).toContain('## Model Information');
    expect(prompt).toContain('## vLLM Deployment Configuration');
    expect(prompt).toContain('## Stage 1 Benchmark Results');
    expect(prompt).toContain('## Stage 2 Evaluation Results');
    expect(prompt).toContain('## Trace Analysis');
    expect(prompt).toContain('## Instructions');
  });

  it('includes stage1 error when benchmark failed', () => {
    const prompt = builder.build({
      pipelineRun: createPipelineRun(),
      vllmConfig: createHFCardResult(),
      stage1Result: createStage1Result({
        status: 'failed',
        metrics: null,
        error: 'Deployment crashed during benchmark',
      }),
      stage2Result: createStage2Result(),
      traceSummary: createTraceSummary(),
    });

    expect(prompt).toContain('Status: failed');
    expect(prompt).toContain('Deployment crashed during benchmark');
    expect(prompt).toContain('No metrics collected');
  });

  it('shows stage2 skipped status correctly', () => {
    const prompt = builder.build({
      pipelineRun: createPipelineRun(),
      vllmConfig: createHFCardResult(),
      stage1Result: createStage1Result(),
      stage2Result: createStage2Result({ status: 'skipped' }),
      traceSummary: createTraceSummary(),
    });

    expect(prompt).toContain('Status: skipped');
    expect(prompt).not.toContain('Stage 2 was not run');
  });

  it('limits trace top errors to 5', () => {
    const manyErrors = Array.from({ length: 20 }, (_, i) => ({
      operation: `err-${i}`,
      count: i + 1,
      sampleMessage: `msg-${i}`,
    }));

    const prompt = builder.build({
      pipelineRun: createPipelineRun(),
      vllmConfig: createHFCardResult(),
      stage1Result: createStage1Result(),
      stage2Result: createStage2Result(),
      traceSummary: createTraceSummary({ topErrors: manyErrors }),
    });

    // Should only show up to 5 error lines under "Top errors:"
    const topErrorsSection = prompt.split('## Trace Analysis')[1] ?? '';
    const errorLines = topErrorsSection.split('\n').filter((line) => line.startsWith('  - err-'));
    expect(errorLines.length).toBe(5);
  });

  it('limits trace operations to top 10', () => {
    const manyOps = Array.from({ length: 25 }, (_, i) => ({
      name: `op-${i}`,
      count: i + 1,
      avgDurationMs: i * 1.5,
      errorRate: i / 200,
    }));

    const prompt = builder.build({
      pipelineRun: createPipelineRun(),
      vllmConfig: createHFCardResult(),
      stage1Result: createStage1Result(),
      stage2Result: createStage2Result(),
      traceSummary: createTraceSummary({ operations: manyOps }),
    });

    const traceSection = prompt.split('## Trace Analysis')[1] ?? '';
    const opLines = traceSection.split('\n').filter((line) => line.startsWith('  - op-'));
    expect(opLines.length).toBe(10);
  });

  it('truncates raw output longer than 2,000 chars', () => {
    const longRaw = 'a'.repeat(5_000);
    const prompt = builder.build({
      pipelineRun: createPipelineRun(),
      vllmConfig: createHFCardResult(),
      stage1Result: createStage1Result({ rawOutput: longRaw }),
      stage2Result: createStage2Result(),
      traceSummary: createTraceSummary(),
    });

    expect(prompt).toContain('... [truncated]');
    // Should not contain the full 5000 chars of raw output in the prompt
    expect(prompt.indexOf('a'.repeat(2_500))).toBe(-1);
  });
});
