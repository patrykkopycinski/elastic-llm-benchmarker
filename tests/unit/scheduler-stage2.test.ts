import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import type { QueueService, QueueEntry } from '../../src/services/queue-service.js';
import type { Stage1Worker, Stage2Worker } from '../../src/worker/index.js';
import type { Stage1Result, Stage2Result, PipelineRun } from '../../src/scheduler/pipeline-state.js';
import type { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';

// ─── Mock Helpers ────────────────────────────────────────────────────────────

function createMockQueueService(): QueueService {
  const mock = {
    esClient: {} as unknown as QueueService['esClient'],
    enqueue: vi.fn(),
    dequeue: vi.fn().mockResolvedValue(null),
    getQueue: vi.fn(),
    getById: vi.fn(),
    getCurrent: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    findPending: vi.fn().mockResolvedValue([]),
    failActiveEntries: vi.fn().mockResolvedValue(0),
    getActiveEntries: vi.fn().mockResolvedValue([]),
    hasPending: vi.fn(),
    shouldAutoStop: vi.fn(),
  };
  return mock as unknown as QueueService;
}

function createMockResultsStore(): ElasticsearchResultsStore {
  const store = {
    saveStage2Result: vi.fn().mockResolvedValue(undefined),
  };
  return store as unknown as ElasticsearchResultsStore;
}

function createMockStage1Worker(overrides?: Partial<Stage1Worker>): Stage1Worker {
  return {
    execute: vi.fn().mockResolvedValue({
      runId: 'run-1',
      modelId: 'test-model',
      queueEntryId: 'entry-1',
      status: 'success' as const,
      metrics: null,
      rawOutput: '',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    } satisfies Stage1Result),
    ...overrides,
  };
}

function createMockStage2Worker(overrides?: Partial<Stage2Worker>): Stage2Worker {
  return {
    execute: vi.fn().mockResolvedValue({
      runId: 'run-1',
      modelId: 'test-model',
      status: 'success' as const,
      scores: { tool_calls: 0.95 },
      suiteResults: [{ suite: 'tool_calls', status: 'pass', score: 0.95 }],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    } satisfies Stage2Result),
    ...overrides,
  };
}

function createQueueEntry(overrides?: Partial<QueueEntry>): QueueEntry {
  return {
    id: 'entry-1',
    modelId: 'meta-llama/Llama-3-8B',
    source: 'user',
    priority: 100,
    status: 'pending',
    requestedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    requestedBy: null,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Scheduler Stage 2 chaining', () => {
  let queueService: ReturnType<typeof createMockQueueService>;
  let stage1Worker: Stage1Worker;
  let stage2Worker: Stage2Worker;
  let resultsStore: ReturnType<typeof createMockResultsStore>;
  let scheduler: Scheduler;

  beforeEach(() => {
    queueService = createMockQueueService();
    stage1Worker = createMockStage1Worker();
    stage2Worker = createMockStage2Worker();
    resultsStore = createMockResultsStore();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    if (scheduler) {
      await scheduler.stop();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('without stage2', () => {
    it('should process entry and mark completed when stage1 succeeds', async () => {
      queueService.dequeue.mockResolvedValueOnce(createQueueEntry());
      scheduler = new Scheduler(queueService, stage1Worker, {
        pollIntervalMs: 1000,
        maxConcurrentRuns: 1,
      });

      await scheduler.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(stage1Worker.execute).toHaveBeenCalledTimes(1);
      expect(queueService.updateStatus).toHaveBeenLastCalledWith('entry-1', 'completed');
    });

    it('should mark failed when stage1 fails', async () => {
      queueService.dequeue.mockResolvedValueOnce(createQueueEntry());
      stage1Worker = createMockStage1Worker({
        execute: vi.fn().mockResolvedValue({
          runId: 'run-1',
          modelId: 'test-model',
          queueEntryId: 'entry-1',
          status: 'failed' as const,
          metrics: null,
          rawOutput: '',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      });
      scheduler = new Scheduler(queueService, stage1Worker, {
        pollIntervalMs: 1000,
        maxConcurrentRuns: 1,
      });

      await scheduler.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(queueService.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', undefined);
    });
  });

  describe('with stage2', () => {
    it('should run stage2 after stage1 success and mark completed when stage2 succeeds', async () => {
      queueService.dequeue.mockResolvedValueOnce(createQueueEntry());
      scheduler = new Scheduler(
        queueService,
        stage1Worker,
        { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
      );

      await scheduler.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(stage1Worker.execute).toHaveBeenCalledTimes(1);
      expect(stage2Worker.execute).toHaveBeenCalledTimes(1);
      const runArg = (stage2Worker.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as PipelineRun;
      expect(runArg.modelId).toBe('meta-llama/Llama-3-8B');
      expect(resultsStore.saveStage2Result).toHaveBeenCalledTimes(1);
      expect(queueService.updateStatus).toHaveBeenLastCalledWith('entry-1', 'completed');
    });

    it('should mark completed when stage2 is skipped', async () => {
      queueService.dequeue.mockResolvedValueOnce(createQueueEntry());
      stage2Worker = createMockStage2Worker({
        execute: vi.fn().mockResolvedValue({
          runId: 'run-1',
          modelId: 'test-model',
          status: 'skipped' as const,
          reason: 'ITL too high',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        } satisfies Stage2Result),
      });
      scheduler = new Scheduler(
        queueService,
        stage1Worker,
        { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
      );

      await scheduler.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(stage2Worker.execute).toHaveBeenCalledTimes(1);
      expect(resultsStore.saveStage2Result).toHaveBeenCalledTimes(1);
      expect(queueService.updateStatus).toHaveBeenLastCalledWith('entry-1', 'completed');
    });

    it('should mark failed when stage2 errors', async () => {
      queueService.dequeue.mockResolvedValueOnce(createQueueEntry());
      stage2Worker = createMockStage2Worker({
        execute: vi.fn().mockResolvedValue({
          runId: 'run-1',
          modelId: 'test-model',
          status: 'error' as const,
          reason: 'repo bootstrap failed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        } satisfies Stage2Result),
      });
      scheduler = new Scheduler(
        queueService,
        stage1Worker,
        { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
      );

      await scheduler.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(stage2Worker.execute).toHaveBeenCalledTimes(1);
      expect(queueService.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'repo bootstrap failed');
    });
  });
});
