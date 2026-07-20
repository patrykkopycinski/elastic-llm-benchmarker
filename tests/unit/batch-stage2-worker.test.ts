import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'winston';
import { createBatchStage2Worker } from '../../src/worker/batch-stage2-worker.js';
import type { Stage2Worker } from '../../src/worker/stage2-worker.js';
import type { Stage2Gate } from '../../src/worker/stage2-gate.js';
import type { LocalBatchEvalRunner, LocalBatchEvalResult } from '../../src/services/local-batch-eval-runner.js';
import type { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';
import type { AppConfig } from '../../src/types/config.js';
import type { PipelineRun, Stage1Result } from '../../src/scheduler/pipeline-state.js';

function createPipelineRun(overrides?: Partial<PipelineRun>): PipelineRun {
  return {
    runId: 'run-1',
    modelId: 'my-org/my-model',
    queueEntryId: 'entry-1',
    stage: 'benchmark',
    startedAt: new Date().toISOString(),
    deployment: {
      deploymentName: 'deploy-1',
      containerId: 'abc123',
      endpointUrl: 'http://10.0.0.5:8000/v1',
      status: 'deployed',
    },
    ...overrides,
  };
}

function createStage1Result(overrides?: Partial<Stage1Result>): Stage1Result {
  return {
    runId: 'run-1',
    modelId: 'my-org/my-model',
    queueEntryId: 'entry-1',
    status: 'success',
    metrics: {
      itl_p50_ms: 100,
      itl_p99_ms: 200,
      ttft_ms: 200,
      throughput_tps: 50,
      duration_sec: 60,
    },
    rawOutput: '',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createBatchResult(overrides?: Partial<LocalBatchEvalResult>): LocalBatchEvalResult {
  return {
    modelId: 'my-org/my-model',
    status: 'success',
    suites: [
      { suite: 'security-alert-triage', status: 'pass', durationMs: 1000, logPath: '/log/a.log' },
      { suite: 'security-esql-generation-regression', status: 'pass', durationMs: 2000, logPath: '/log/b.log' },
    ],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    summaryPath: '/tmp/batch-summary.json',
    ...overrides,
  };
}

describe('createBatchStage2Worker', () => {
  let worker: Stage2Worker;
  let gate: Stage2Gate;
  let batchRunner: LocalBatchEvalRunner;
  let resultsStore: ElasticsearchResultsStore;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    gate = { check: vi.fn() } as unknown as Stage2Gate;
    batchRunner = { run: vi.fn() } as unknown as LocalBatchEvalRunner;
    resultsStore = {
      saveStage2Result: vi.fn().mockResolvedValue(undefined),
    } as unknown as ElasticsearchResultsStore;
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    worker = createBatchStage2Worker({
      config: {
        stage2Local: {
          pauseAlwaysOnStack: false,
          teardownBatchStack: true,
          evalSuites: [
            'security-alert-triage',
            'security-esql-generation-regression',
          ],
        },
      } as AppConfig,
      gate,
      batchRunner,
      resultsStore,
      logger: logger as unknown as Logger,
    });
  });

  it('returns skipped when gate blocks', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: false, reason: 'ITL too high' });

    const result = await worker.execute(createPipelineRun(), createStage1Result());

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('ITL too high');
    expect(batchRunner.run).not.toHaveBeenCalled();
  });

  it('returns failed when no deployment endpoint exists', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: true, reason: 'ok' });

    const result = await worker.execute(createPipelineRun({ deployment: undefined }), createStage1Result());

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('No deployment endpoint');
    expect(batchRunner.run).not.toHaveBeenCalled();
  });

  it('maps a successful batch run into scores keyed by suite id', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: true, reason: 'ok' });
    vi.mocked(batchRunner.run).mockResolvedValue(createBatchResult());

    const result = await worker.execute(createPipelineRun(), createStage1Result());

    expect(result.status).toBe('success');
    expect(result.scores).toEqual({
      'security-alert-triage': 1,
      'security-esql-generation-regression': 1,
    });
    expect(result.suiteResults).toEqual([
      {
        suite: 'security-alert-triage',
        status: 'pass',
        score: 1,
        durationMs: 1000,
        logPath: '/log/a.log',
      },
      {
        suite: 'security-esql-generation-regression',
        status: 'pass',
        score: 1,
        durationMs: 2000,
        logPath: '/log/b.log',
      },
    ]);
    expect(result.batchSummaryPath).toBe('/tmp/batch-summary.json');
    expect(resultsStore.saveStage2Result).toHaveBeenCalledOnce();
  });

  it('maps a partial batch run (some suites failed) to a partial Stage2Result', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: true, reason: 'ok' });
    vi.mocked(batchRunner.run).mockResolvedValue(
      createBatchResult({
        status: 'partial',
        suites: [
          { suite: 'security-alert-triage', status: 'pass', durationMs: 1000 },
          { suite: 'security-esql-generation-regression', status: 'fail', durationMs: 500 },
        ],
      }),
    );

    const result = await worker.execute(createPipelineRun(), createStage1Result());

    expect(result.status).toBe('partial');
    expect(result.scores).toEqual({
      'security-alert-triage': 1,
      'security-esql-generation-regression': 0,
    });
  });

  it('uses specPassRate as a fractional score for a fail-status suite instead of flat 0', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: true, reason: 'ok' });
    vi.mocked(batchRunner.run).mockResolvedValue(
      createBatchResult({
        status: 'partial',
        suites: [
          { suite: 'security-alert-triage', status: 'pass', durationMs: 1000 },
          {
            suite: 'agent-builder',
            status: 'fail',
            durationMs: 4200000,
            specPassRate: 24 / 30,
          },
        ],
      }),
    );

    const result = await worker.execute(createPipelineRun(), createStage1Result());

    expect(result.scores).toEqual({
      'security-alert-triage': 1,
      'agent-builder': 24 / 30,
    });
    expect(result.suiteResults?.[1]).toEqual({
      suite: 'agent-builder',
      status: 'fail',
      score: 24 / 30,
      durationMs: 4200000,
      logPath: undefined,
    });
  });

  it('logs a warning but still returns the result when saveStage2Result rejects', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: true, reason: 'ok' });
    vi.mocked(batchRunner.run).mockResolvedValue(createBatchResult());
    vi.mocked(resultsStore.saveStage2Result).mockRejectedValue(new Error('ES timeout'));

    const result = await worker.execute(createPipelineRun(), createStage1Result());

    expect(result.status).toBe('success');
    expect(logger.warn).toHaveBeenCalledWith(
      'Stage 2 (batch): failed to persist result to results store',
      expect.objectContaining({ runId: 'run-1', modelId: 'my-org/my-model', error: 'ES timeout' }),
    );
  });

  it('returns error status when the batch runner throws', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: true, reason: 'ok' });
    vi.mocked(batchRunner.run).mockRejectedValue(new Error('batch script crashed'));

    const result = await worker.execute(createPipelineRun(), createStage1Result());

    expect(result.status).toBe('error');
    expect(result.reason).toBe('batch script crashed');
    expect(resultsStore.saveStage2Result).not.toHaveBeenCalled();
  });
});
