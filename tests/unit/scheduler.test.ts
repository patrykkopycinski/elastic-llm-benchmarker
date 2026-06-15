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

  let findPendingMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findPendingMock = vi.fn().mockResolvedValue([]);
    queueService = {
      findPending: findPendingMock,
      updateStatus: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn().mockResolvedValue(undefined),
      claim: vi.fn().mockResolvedValue(null),
      complete: vi.fn().mockResolvedValue(undefined),
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
    findPendingMock.mockResolvedValue([baseEntry]);

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

    // Queue status updated to completed (2 args: id, status)
    expect(queueService.updateStatus).toHaveBeenLastCalledWith(
      baseEntry.id,
      'completed',
    );
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
    findPendingMock.mockResolvedValue([baseEntry]);

    await scheduler.start();
    await new Promise((r) => setTimeout(r, 100));
    await scheduler.stop();

    expect(stage1Worker.execute).toHaveBeenCalledTimes(1);
    expect(stage2Worker.execute).not.toHaveBeenCalled();
    expect(stage3Worker.execute).not.toHaveBeenCalled();
    expect(queueService.updateStatus).toHaveBeenLastCalledWith(
      baseEntry.id,
      'failed',
      'deployment_timeout',
    );
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
    findPendingMock.mockResolvedValue([baseEntry]);

    await scheduler.start();
    await new Promise((r) => setTimeout(r, 100));
    await scheduler.stop();

    expect(stage1Worker.execute).toHaveBeenCalledTimes(1);
    expect(stage2Worker.execute).toHaveBeenCalledTimes(1);
    // Stage 3 should NOT run when Stage 2 fails
    expect(stage3Worker.execute).not.toHaveBeenCalled();
    expect(queueService.updateStatus).toHaveBeenLastCalledWith(
      baseEntry.id,
      'failed',
      'eval_suite_failed',
    );
  });
});
