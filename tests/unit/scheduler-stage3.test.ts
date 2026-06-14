import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import type { QueueService, QueueEntry } from '../../src/services/queue-service.js';
import type { Stage1Worker, Stage2Worker, Stage3Worker } from '../../src/worker/index.js';
import type { Stage1Result, Stage2Result, Stage3Result, PipelineRun } from '../../src/scheduler/pipeline-state.js';
import type { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';

// ─── Mock Helpers ────────────────────────────────────────────────────────────

function createMockQueueService(): QueueService {
  const mock = {
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

function createMockStage3Worker(overrides?: Partial<Stage3Worker>): Stage3Worker {
  return {
    execute: vi.fn().mockResolvedValue({
      runId: 'run-1',
      modelId: 'test-model',
      status: 'success' as const,
      suggestions: [
        {
          category: 'config' as const,
          title: 'Enable chunked prefill',
          description: 'Split long prompts into chunks for better TTFT.',
          estimatedImpact: 'high' as const,
        },
      ],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    } satisfies Stage3Result),
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

describe('Scheduler Stage 3 chaining', () => {
  let queueService: ReturnType<typeof createMockQueueService>;
  let stage1Worker: Stage1Worker;
  let stage2Worker: Stage2Worker;
  let stage3Worker: Stage3Worker;
  let resultsStore: ReturnType<typeof createMockResultsStore>;
  let scheduler: Scheduler;

  beforeEach(() => {
    queueService = createMockQueueService();
    stage1Worker = createMockStage1Worker();
    stage2Worker = createMockStage2Worker();
    stage3Worker = createMockStage3Worker();
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

  it('should call stage3Worker.execute when stage3Worker is provided', async () => {
    queueService.findPending.mockResolvedValue([createQueueEntry()]);
    scheduler = new Scheduler(
      queueService,
      stage1Worker,
      { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
      stage2Worker,
      resultsStore,
      stage3Worker,
    );

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(stage3Worker.execute).toHaveBeenCalledTimes(1);
    const runArg = (stage3Worker.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as PipelineRun;
    expect(runArg.modelId).toBe('meta-llama/Llama-3-8B');
  });

  it('should transition run to COMPLETED when stage3 succeeds', async () => {
    queueService.findPending.mockResolvedValue([createQueueEntry()]);
    scheduler = new Scheduler(
      queueService,
      stage1Worker,
      { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
      stage2Worker,
      resultsStore,
      stage3Worker,
    );

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(queueService.updateStatus).toHaveBeenLastCalledWith('entry-1', 'completed');
  });

  it('should transition run to FAILED when stage3 returns error', async () => {
    queueService.findPending.mockResolvedValue([createQueueEntry()]);
    stage3Worker = createMockStage3Worker({
      execute: vi.fn().mockResolvedValue({
        runId: 'run-1',
        modelId: 'test-model',
        status: 'error' as const,
        error: 'LLM API key missing',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      } satisfies Stage3Result),
    });
    scheduler = new Scheduler(
      queueService,
      stage1Worker,
      { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
      stage2Worker,
      resultsStore,
      stage3Worker,
    );

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(stage3Worker.execute).toHaveBeenCalledTimes(1);
    expect(queueService.updateStatus).toHaveBeenLastCalledWith('entry-1', 'failed', 'LLM API key missing');
  });

  it('should transition directly to COMPLETED when no stage3Worker is provided', async () => {
    queueService.findPending.mockResolvedValue([createQueueEntry()]);
    scheduler = new Scheduler(
      queueService,
      stage1Worker,
      { pollIntervalMs: 1000, maxConcurrentRuns: 1 },
      stage2Worker,
      resultsStore,
      // stage3Worker intentionally omitted
    );

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(queueService.updateStatus).toHaveBeenLastCalledWith('entry-1', 'completed');
  });
});
