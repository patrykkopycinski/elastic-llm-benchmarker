import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import type {
  QueueService,
  QueueEntry,
} from '../../src/services/queue-service.js';
import type {
  Stage1Worker,
  Stage2Worker,
  Stage3Worker,
} from '../../src/worker/index.js';
import type { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';
import type {
  Stage1Result,
  Stage2Result,
  Stage3Result,
} from '../../src/scheduler/pipeline-state.js';

describe('Scheduler', () => {
  let queueService: QueueService;
  let stage1Worker: Stage1Worker;
  let stage2Worker: Stage2Worker;
  let stage3Worker: Stage3Worker;
  let resultsStore: ElasticsearchResultsStore;
  let scheduler: Scheduler;

  const baseEntry: QueueEntry = {
    id: 'entry-1',
    modelId: 'meta-llama/Llama-3-8B',
    source: 'user',
    priority: 1,
    status: 'pending',
    requestedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    requestedBy: null,
    leaseToken: 'lease-1',
    heartbeatAt: null,
  };

  const successStage1: Stage1Result = {
    runId: 'run-1',
    modelId: baseEntry.modelId,
    queueEntryId: baseEntry.id,
    status: 'success',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    metrics: {
      itl_p50_ms: 15,
      itl_p99_ms: 25,
      ttft_ms: 120,
      throughput_tps: 40,
      duration_sec: 15,
    },
    rawOutput: 'benchmark output',
  };

  const successStage2: Stage2Result = {
    runId: 'run-1',
    modelId: baseEntry.modelId,
    queueEntryId: baseEntry.id,
    status: 'success',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    scores: { tool_use: 0.85 },
    suiteResults: [
      { suite: 'tool_use', status: 'pass', score: 0.85 },
    ],
  };

  const successStage3: Stage3Result = {
    runId: 'run-1',
    modelId: baseEntry.modelId,
    queueEntryId: baseEntry.id,
    status: 'success',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    suggestions: [
      {
        category: 'config',
        title: 'Increase GPU memory utilisation',
        description: 'Use --gpu-memory-utilization 0.95',
        estimatedImpact: 'medium',
      },
    ],
  };

  let dequeueMock: ReturnType<typeof vi.fn>;
  let getCurrentMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dequeueMock = vi.fn().mockResolvedValue(null);
    getCurrentMock = vi.fn().mockResolvedValue(null);
    queueService = {
      dequeue: dequeueMock,
      getCurrent: getCurrentMock,
      findPending: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn().mockResolvedValue(true),
      enqueue: vi.fn().mockResolvedValue(undefined),
      claim: vi.fn().mockResolvedValue(null),
      complete: vi.fn().mockResolvedValue({ applied: true }),
      fail: vi.fn().mockResolvedValue({ applied: true }),
      cancelActive: vi.fn().mockResolvedValue({ applied: true }),
      heartbeat: vi.fn().mockResolvedValue(true),
      adoptEntry: vi.fn().mockResolvedValue('adopted-token'),
      countTerminalSince: vi.fn().mockResolvedValue(0),
      reclaimStaleEntries: vi.fn().mockResolvedValue(0),
    } as unknown as QueueService;

    stage1Worker = {
      execute: vi.fn().mockResolvedValue(successStage1),
    } as unknown as Stage1Worker;

    stage2Worker = {
      execute: vi.fn().mockResolvedValue(successStage2),
    } as unknown as Stage2Worker;

    stage3Worker = {
      execute: vi.fn().mockResolvedValue(successStage3),
    } as unknown as Stage3Worker;

    resultsStore = {
      saveStage2Result: vi.fn().mockResolvedValue(undefined),
      saveReasoningResult: vi.fn().mockResolvedValue(undefined),
      getLatestReasoningResult: vi.fn().mockResolvedValue(null),
    } as unknown as ElasticsearchResultsStore;

    scheduler = new Scheduler(
      queueService,
      stage1Worker,
      { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
      stage2Worker,
      resultsStore,
      stage3Worker,
    );
  });

  it('runs full pipeline and persists Stage 2 + Stage 3 results', async () => {
    dequeueMock.mockResolvedValueOnce(baseEntry);

    // Start scheduler, let it poll once, then stop
    await scheduler.start();
    // Wait for async processEntry to complete
    await new Promise((r) => setTimeout(r, 100));
    await scheduler.stop();

    expect(stage1Worker.execute).toHaveBeenCalledTimes(1);
    expect(stage2Worker.execute).toHaveBeenCalledTimes(1);
    expect(stage3Worker.execute).toHaveBeenCalledTimes(1);

    // Stage 2 result persisted
    expect(resultsStore.saveStage2Result).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );

    // Stage 3 result persisted (the fix we just added)
    expect(resultsStore.saveReasoningResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        suggestions: expect.any(Array),
      }),
    );

    // Terminal write is fenced by the held lease token via complete().
    expect(queueService.complete).toHaveBeenCalledWith(baseEntry.id, 'lease-1');
  });

  it('stops at Stage 1 failure and does not chain Stage 2/3', async () => {
    const failedStage1: Stage1Result = {
      ...successStage1,
      status: 'failed',
      error: 'deployment_timeout',
    };
    (stage1Worker.execute as ReturnType<typeof vi.fn>).mockResolvedValue(
      failedStage1,
    );
    dequeueMock.mockResolvedValueOnce(baseEntry);

    await scheduler.start();
    await new Promise((r) => setTimeout(r, 100));
    await scheduler.stop();

    expect(stage1Worker.execute).toHaveBeenCalledTimes(1);
    expect(stage2Worker.execute).not.toHaveBeenCalled();
    expect(stage3Worker.execute).not.toHaveBeenCalled();
    // Routed through failEntry → fenced fail(): 'deployment_timeout' is
    // unclassified (unknown, non-retriable) so the message is untagged and no
    // auto-retry fires. The held lease token fences the terminal write.
    expect(queueService.fail).toHaveBeenCalledWith(
      baseEntry.id,
      'deployment_timeout',
      'lease-1',
    );
    expect(queueService.enqueue).not.toHaveBeenCalled();
  });

  it('handles Stage 2 failure gracefully', async () => {
    const failedStage2: Stage2Result = {
      ...successStage2,
      status: 'error',
      reason: 'eval_suite_failed',
    };
    (stage2Worker.execute as ReturnType<typeof vi.fn>).mockResolvedValue(
      failedStage2,
    );
    dequeueMock.mockResolvedValueOnce(baseEntry);

    await scheduler.start();
    await new Promise((r) => setTimeout(r, 100));
    await scheduler.stop();

    expect(stage1Worker.execute).toHaveBeenCalledTimes(1);
    expect(stage2Worker.execute).toHaveBeenCalledTimes(1);
    // Stage 3 should NOT run when Stage 2 fails
    expect(stage3Worker.execute).not.toHaveBeenCalled();
    expect(queueService.fail).toHaveBeenCalledWith(
      baseEntry.id,
      'eval_suite_failed',
      'lease-1',
    );
  });

  it('resumes in-flight entry instead of dequeuing another', async () => {
    getCurrentMock.mockResolvedValue({
      ...baseEntry,
      status: 'benchmarking',
    });

    await scheduler.start();
    await new Promise((r) => setTimeout(r, 100));
    await scheduler.stop();

    expect(dequeueMock).not.toHaveBeenCalled();
    expect(stage1Worker.execute).toHaveBeenCalledTimes(1);
  });

  describe('cost cap', () => {
    const configWithCap = (maxModelsPerDay: number) =>
      ({
        logLevel: 'error',
        costCaps: { enabled: true, maxModelsPerDay },
        retry: { enabled: true, maxInfraRetries: 2, maxResourceFitRetries: 1 },
      }) as never;

    it('pauses new dequeues once the daily terminal-model cap is reached', async () => {
      (queueService.countTerminalSince as ReturnType<typeof vi.fn>).mockResolvedValue(5);
      scheduler = new Scheduler(
        queueService,
        stage1Worker,
        { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
        stage3Worker,
        configWithCap(5),
      );

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 50));
      await scheduler.stop();

      // Cap reached → never dequeues, never touches the VM.
      expect(dequeueMock).not.toHaveBeenCalled();
      expect(stage1Worker.execute).not.toHaveBeenCalled();
    });

    it('still dequeues while under the daily cap', async () => {
      (queueService.countTerminalSince as ReturnType<typeof vi.fn>).mockResolvedValue(2);
      dequeueMock.mockResolvedValueOnce(baseEntry);
      scheduler = new Scheduler(
        queueService,
        stage1Worker,
        { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
        stage3Worker,
        configWithCap(5),
      );

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 100));
      await scheduler.stop();

      expect(dequeueMock).toHaveBeenCalled();
      expect(stage1Worker.execute).toHaveBeenCalledTimes(1);
    });

    it('does not gate when cost caps are disabled', async () => {
      (queueService.countTerminalSince as ReturnType<typeof vi.fn>).mockResolvedValue(999);
      dequeueMock.mockResolvedValueOnce(baseEntry);
      // No config → costCaps undefined → gate is a no-op.
      await scheduler.start();
      await new Promise((r) => setTimeout(r, 100));
      await scheduler.stop();

      expect(dequeueMock).toHaveBeenCalled();
      expect(stage1Worker.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('recency exclude guard', () => {
    const configWithExclude = () =>
      ({
        logLevel: 'error',
        costCaps: { enabled: false, maxModelsPerDay: 20 },
        retry: { enabled: true, maxInfraRetries: 2, maxResourceFitRetries: 1 },
        discoveryScheduler: { excludeModelPatterns: ['qwen2', 'llama-2'] },
      }) as never;

    const qwen25Entry: QueueEntry = {
      ...baseEntry,
      id: 'entry-qwen25',
      modelId: 'Qwen/Qwen2.5-32B-Instruct-AWQ',
      leaseToken: 'lease-q',
    };

    it('retires a leftover pending entry whose model is denylisted (no Stage 1)', async () => {
      dequeueMock.mockResolvedValueOnce(qwen25Entry);
      scheduler = new Scheduler(
        queueService,
        stage1Worker,
        { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
        stage3Worker,
        configWithExclude(),
      );

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 100));
      await scheduler.stop();

      expect(stage1Worker.execute).not.toHaveBeenCalled();
      // Retired as `cancelled` (not `failed`) so it never counts toward the
      // daily cost cap or blocks re-discovery — a denylist skip is not an eval.
      expect(queueService.cancelActive).toHaveBeenCalledWith(
        qwen25Entry.id,
        expect.stringContaining('excludeModelPatterns'),
        'lease-q',
      );
    });

    it('retires an in-flight denylisted entry on resume instead of redeploying', async () => {
      getCurrentMock.mockResolvedValue({ ...qwen25Entry, status: 'benchmarking' });
      scheduler = new Scheduler(
        queueService,
        stage1Worker,
        { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
        stage3Worker,
        configWithExclude(),
      );

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 100));
      await scheduler.stop();

      expect(stage1Worker.execute).not.toHaveBeenCalled();
      // Fenced by the ADOPTED lease token (adoptEntry mock returns 'adopted-token').
      expect(queueService.cancelActive).toHaveBeenCalledWith(
        qwen25Entry.id,
        expect.stringContaining('excludeModelPatterns'),
        'adopted-token',
      );
    });

    it('honors --force: a denylisted but force-enqueued entry still runs', async () => {
      dequeueMock.mockResolvedValueOnce({ ...qwen25Entry, metadata: { force: true } });
      scheduler = new Scheduler(
        queueService,
        stage1Worker,
        { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
        stage3Worker,
        configWithExclude(),
      );

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 100));
      await scheduler.stop();

      expect(stage1Worker.execute).toHaveBeenCalledTimes(1);
    });

    it('does not retire when no excludeModelPatterns are configured', async () => {
      // Base scheduler from beforeEach has no config → guard is a no-op.
      dequeueMock.mockResolvedValueOnce(qwen25Entry);

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 100));
      await scheduler.stop();

      expect(stage1Worker.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('failure classification + auto-retry', () => {
    const retryConfig = () =>
      ({
        logLevel: 'error',
        costCaps: { enabled: false, maxModelsPerDay: 20 },
        retry: { enabled: true, maxInfraRetries: 2, maxResourceFitRetries: 1 },
      }) as never;

    it('re-enqueues on a transient-infra Stage 1 failure (within budget)', async () => {
      (stage1Worker.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...successStage1,
        status: 'failed',
        error: 'Health check timed out after 604162ms',
      });
      dequeueMock.mockResolvedValueOnce(baseEntry);
      scheduler = new Scheduler(
        queueService,
        stage1Worker,
        { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
        stage3Worker,
        retryConfig(),
      );

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 100));
      await scheduler.stop();

      // Tagged failed (fenced by lease) + re-enqueued with incremented retry count.
      expect(queueService.fail).toHaveBeenCalledWith(
        baseEntry.id,
        expect.stringContaining('[transient-infra]'),
        'lease-1',
      );
      expect(queueService.enqueue).toHaveBeenCalledWith(
        baseEntry.modelId,
        baseEntry.source,
        baseEntry.priority,
        undefined,
        expect.objectContaining({ infraRetryCount: 1 }),
      );
    });

    it('quarantines (no re-enqueue) on a model-arch failure', async () => {
      (stage1Worker.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...successStage1,
        status: 'failed',
        error: 'Model architectures are not supported by vLLM',
      });
      dequeueMock.mockResolvedValueOnce(baseEntry);
      scheduler = new Scheduler(
        queueService,
        stage1Worker,
        { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
        stage3Worker,
        retryConfig(),
      );

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 100));
      await scheduler.stop();

      expect(queueService.fail).toHaveBeenCalledWith(
        baseEntry.id,
        expect.stringContaining('[model-arch]'),
        'lease-1',
      );
      expect(queueService.enqueue).not.toHaveBeenCalled();
    });

    it('quarantines a transient failure once the retry budget is exhausted', async () => {
      (stage1Worker.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...successStage1,
        status: 'failed',
        error: 'fetch failed',
      });
      // Entry already retried twice (budget maxInfraRetries=2) → no further retry.
      dequeueMock.mockResolvedValueOnce({
        ...baseEntry,
        metadata: { infraRetryCount: 2 },
      });
      scheduler = new Scheduler(
        queueService,
        stage1Worker,
        { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
        stage3Worker,
        retryConfig(),
      );

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 100));
      await scheduler.stop();

      expect(queueService.enqueue).not.toHaveBeenCalled();
      expect(queueService.fail).toHaveBeenCalledWith(
        baseEntry.id,
        expect.stringContaining('[transient-infra]'),
        'lease-1',
      );
    });

    it('does NOT re-enqueue when the fenced fail() is rejected (lease lost)', async () => {
      // A zombie daemon whose lease was reclaimed must not re-enqueue: the live
      // owner already controls the entry. fail() reports the write did not apply.
      (queueService.fail as ReturnType<typeof vi.fn>).mockResolvedValue({
        applied: false,
        reason: 'lease-mismatch',
      });
      (stage1Worker.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...successStage1,
        status: 'failed',
        error: 'fetch failed',
      });
      dequeueMock.mockResolvedValueOnce(baseEntry);
      scheduler = new Scheduler(
        queueService,
        stage1Worker,
        { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
        stage3Worker,
        retryConfig(),
      );

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 100));
      await scheduler.stop();

      expect(queueService.fail).toHaveBeenCalledWith(
        baseEntry.id,
        expect.stringContaining('[transient-infra]'),
        'lease-1',
      );
      // Fenced out → no duplicate re-enqueue.
      expect(queueService.enqueue).not.toHaveBeenCalled();
    });
  });
});
