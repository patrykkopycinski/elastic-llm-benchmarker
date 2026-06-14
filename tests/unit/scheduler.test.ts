import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import type { QueueService, QueueEntry } from '../../src/services/queue-service.js';
import type { Stage1Worker } from '../../src/worker/index.js';
import type { Stage1Result, PipelineRun } from '../../src/scheduler/pipeline-state.js';

// ─── Mock Helpers ────────────────────────────────────────────────────────────

function createMockQueueService(): QueueService {
  return {
    esClient: {} as unknown as QueueService['esClient'],
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    getQueue: vi.fn(),
    getById: vi.fn(),
    getCurrent: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    findPending: vi.fn().mockResolvedValue([]),
    hasPending: vi.fn(),
    shouldAutoStop: vi.fn(),
  } as unknown as QueueService;
}

function createMockWorker(overrides?: Partial<Stage1Worker>): Stage1Worker {
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

describe('Scheduler', () => {
  let queueService: ReturnType<typeof createMockQueueService>;
  let worker: Stage1Worker;
  let scheduler: Scheduler;

  beforeEach(() => {
    queueService = createMockQueueService();
    worker = createMockWorker();
    scheduler = new Scheduler(queueService, worker, {
      pollIntervalMs: 1000,
      maxConcurrentRuns: 1,
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    await scheduler.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start / stop', () => {
    it('should start polling and process a pending entry', async () => {
      queueService.findPending.mockResolvedValue([createQueueEntry()]);

      await scheduler.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(worker.execute).toHaveBeenCalledTimes(1);
      const callArg = (worker.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as PipelineRun;
      expect(callArg.modelId).toBe('meta-llama/Llama-3-8B');
    });

    it('should not call worker when no pending entries exist', async () => {
      queueService.findPending.mockResolvedValue([]);

      await scheduler.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(worker.execute).not.toHaveBeenCalled();
    });

    it('should stop polling after stop() is called', async () => {
      queueService.findPending.mockResolvedValue([createQueueEntry()]);

      await scheduler.start();
      await scheduler.stop();
      await vi.advanceTimersByTimeAsync(2000);

      expect(worker.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('maxConcurrentRuns', () => {
    it('should not call worker when maxConcurrentRuns is reached', async () => {
      queueService.findPending.mockResolvedValue([
        createQueueEntry({ id: 'entry-1', modelId: 'model-a' }),
        createQueueEntry({ id: 'entry-2', modelId: 'model-b' }),
      ]);

      const slowExecute = vi.fn(() => new Promise<Stage1Result>((resolve) => {
        setTimeout(() => resolve({
          runId: 'run-1',
          modelId: 'model-a',
          queueEntryId: 'entry-1',
          status: 'success' as const,
          metrics: null,
          rawOutput: '',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }), 5000);
      }));

      const slowWorker: Stage1Worker = { execute: slowExecute };
      const limitedScheduler = new Scheduler(queueService, slowWorker, {
        pollIntervalMs: 1000,
        maxConcurrentRuns: 1,
      });

      await limitedScheduler.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(slowExecute).toHaveBeenCalledTimes(1);

      // Second poll should skip because activeRuns == maxConcurrentRuns
      await vi.advanceTimersByTimeAsync(2000);
      expect(slowExecute).toHaveBeenCalledTimes(1);

      await limitedScheduler.stop();
    });
  });

  describe('graceful shutdown', () => {
    it('should wait for active runs to complete before resolving stop()', async () => {
      let resolveExecute: (value: Stage1Result) => void;
      const executePromise = new Promise<Stage1Result>((resolve) => {
        resolveExecute = resolve;
      });

      const blockingWorker: Stage1Worker = {
        execute: vi.fn(() => executePromise),
      };

      queueService.findPending.mockResolvedValue([createQueueEntry()]);

      const limitedScheduler = new Scheduler(queueService, blockingWorker, {
        pollIntervalMs: 1000,
        maxConcurrentRuns: 1,
      });

      await limitedScheduler.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(blockingWorker.execute).toHaveBeenCalledTimes(1);

      // stop() should block until execute resolves
      const stopPromise = limitedScheduler.stop();
      await vi.advanceTimersByTimeAsync(500);

      // stop should not have resolved yet because execute is still pending
      const stopResolvedEarly = await Promise.race([
        stopPromise.then(() => true),
        Promise.resolve(false),
      ]);
      expect(stopResolvedEarly).toBe(false);

      resolveExecute!({
        runId: 'run-1',
        modelId: 'model-a',
        queueEntryId: 'entry-1',
        status: 'success' as const,
        metrics: null,
        rawOutput: '',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      // Give a tick for the finally block and for the setTimeout in stop()
      await vi.advanceTimersByTimeAsync(2000);

      // Now stop should be done
      await stopPromise;
    });

    it('should update entry status to failed when worker throws', async () => {
      const failingWorker: Stage1Worker = {
        execute: vi.fn().mockRejectedValue(new Error('worker exploded')),
      };

      queueService.findPending.mockResolvedValue([createQueueEntry()]);

      const failScheduler = new Scheduler(queueService, failingWorker, {
        pollIntervalMs: 1000,
        maxConcurrentRuns: 1,
      });

      await failScheduler.start();
      await vi.advanceTimersByTimeAsync(100);

      // Give time for the async processEntry to complete
      await vi.advanceTimersByTimeAsync(500);

      expect(queueService.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'worker exploded');
    });
  });
});
