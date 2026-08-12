import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import type { QueueService, QueueEntry } from '../../src/services/queue-service.js';
import type { Stage1Worker } from '../../src/worker/index.js';

/**
 * Model-cooldown persistence + non-retriable quarantine.
 *
 * Both behaviors were added after live evidence that the benchmarker burned GPU
 * hours re-running known-bad models:
 *
 *  - The 3-strike auto-blacklist lived only in an in-memory Map, so every daemon
 *    restart silently cleared every quarantine. The daemon restarts routinely
 *    (observed: a fresh process ~5h old), so a bad model was re-armed on each
 *    restart. One model accumulated 16 recorded failures.
 *  - A non-retriable `model-arch` failure is deterministic, but still needed 3
 *    strikes before quarantine. Because auto-retry is skipped for those, the
 *    strikes only accrued via discovery re-queueing — observed as 4 consecutive
 *    identical "Stage 2 Kibana CI eval failed" entries for one model.
 */

function createMockQueueService(): QueueService {
  const mock = {
    esClient: {} as unknown as QueueService['esClient'],
    enqueue: vi.fn(),
    dequeue: vi.fn().mockResolvedValue(null),
    getQueue: vi.fn(),
    getById: vi.fn(),
    getCurrent: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue({ applied: true }),
    fail: vi.fn().mockResolvedValue({ applied: true }),
    cancel: vi.fn(),
    findPending: vi.fn().mockResolvedValue([]),
    failActiveEntries: vi.fn().mockResolvedValue(0),
    getActiveEntries: vi.fn().mockResolvedValue([]),
    reclaimStaleEntries: vi.fn().mockResolvedValue(0),
    heartbeat: vi.fn().mockResolvedValue(true),
    adoptEntry: vi.fn().mockResolvedValue(null),
    hasPending: vi.fn(),
    shouldAutoStop: vi.fn(),
    persistModelCooldown: vi.fn().mockResolvedValue(undefined),
    loadActiveModelCooldowns: vi.fn().mockResolvedValue([]),
    clearModelCooldown: vi.fn().mockResolvedValue(undefined),
  };
  return mock as unknown as QueueService;
}

function createMockStage1Worker(): Stage1Worker {
  return {
    execute: vi.fn().mockRejectedValue(new Error('unsupported model architecture')),
  } as unknown as Stage1Worker;
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
  } as QueueEntry;
}

describe('scheduler model cooldown persistence', () => {
  let queueService: QueueService;
  let stage1Worker: Stage1Worker;
  let scheduler: Scheduler | undefined;

  beforeEach(() => {
    queueService = createMockQueueService();
    stage1Worker = createMockStage1Worker();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    if (scheduler) await scheduler.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rehydrates persisted cooldowns on start so a restart does not clear quarantine', async () => {
    const expireAt = Date.now() + 60 * 60 * 1000;
    (queueService.loadActiveModelCooldowns as ReturnType<typeof vi.fn>).mockResolvedValue([
      { modelId: 'bad/model-a', expireAt },
    ]);

    scheduler = new Scheduler(queueService, stage1Worker, {
      pollIntervalMs: 1000,
      maxConcurrentRuns: 1,
    });
    await scheduler.start();

    expect(queueService.loadActiveModelCooldowns).toHaveBeenCalledTimes(1);
  });

  it('still starts when the cooldown store is unavailable', async () => {
    (queueService.loadActiveModelCooldowns as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('index_not_found_exception'),
    );

    scheduler = new Scheduler(queueService, stage1Worker, {
      pollIntervalMs: 1000,
      maxConcurrentRuns: 1,
    });

    // Must not throw — a cooldown-store outage cannot block the daemon.
    await expect(scheduler.start()).resolves.toBeUndefined();
  });

  it('quarantines a non-retriable model-arch failure on the FIRST occurrence', async () => {
    (queueService.dequeue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      createQueueEntry({ modelId: 'bad/unsupported-arch' }),
    );

    scheduler = new Scheduler(queueService, stage1Worker, {
      pollIntervalMs: 1000,
      maxConcurrentRuns: 1,
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    // One failure is enough: the model-arch failure is deterministic.
    expect(queueService.persistModelCooldown).toHaveBeenCalledWith(
      'bad/unsupported-arch',
      expect.any(Number),
      'model-arch',
      1,
    );
  });

  it('does NOT quarantine a retriable transient-infra failure on first occurrence', async () => {
    (queueService.dequeue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      createQueueEntry({ modelId: 'ok/flaky-model' }),
    );
    (stage1Worker.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Health check timed out after 1800000ms'),
    );

    scheduler = new Scheduler(queueService, stage1Worker, {
      pollIntervalMs: 1000,
      maxConcurrentRuns: 1,
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    // Transient failures keep their 3-strike budget — a network blip must not
    // quarantine an otherwise-good model.
    expect(queueService.persistModelCooldown).not.toHaveBeenCalled();
  });
});
