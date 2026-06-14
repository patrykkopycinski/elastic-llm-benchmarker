import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { Stage1WorkerImpl } from '../../src/worker/stage1-worker.js';
import { HFCardParser } from '../../src/services/hf-card-parser.js';
import type { QueueService, QueueEntry } from '../../src/services/queue-service.js';
import type { VllmEngine } from '../../src/engines/vllm-engine.js';
import type { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';
import type { AppConfig } from '../../src/types/config.js';
import type { EngineDeploymentResult, EngineFullBenchmarkResult } from '../../src/engines/engine-types.js';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn().mockRejectedValue(new Error('no cache')),
  readFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

function createMockConfig(): AppConfig {
  return {
    ssh: {
      host: 'test-vm',
      port: 22,
      username: 'testuser',
      password: 'testpass',
      useSudo: false,
    },
    huggingfaceToken: 'hf-test-token',
    benchmarkThresholds: {
      minContextWindow: 128000,
      maxITLMs: 20,
      maxITLMsTiers: [
        { maxParamsBillions: 14, maxITLMs: 20 },
        { maxParamsBillions: 40, maxITLMs: 40 },
        { maxParamsBillions: 80, maxITLMs: 60 },
        { maxParamsBillions: Infinity, maxITLMs: 100 },
      ],
      maxToolCallLatencyMs: 1000,
      minToolCallSuccessRate: 1.0,
      concurrencyLevels: [1, 4, 16],
      healthCheckTimeoutSeconds: 1200,
    },
    vmHardwareProfile: {
      gpuType: 'NVIDIA A100',
      gpuCount: 4,
      ramGb: 320,
      cpuCores: 48,
      diskGb: 1000,
      machineType: 'a2-ultragpu-2g',
    },
    stage2Thresholds: {
      minItlP50Ms: 20,
      minThroughputTps: 10,
      maxTtftMs: 5000,
      minContextWindow: 128000,
    },
    hardwareProfileId: '2xa100-80gb',
    logLevel: 'error',
    resultsDir: './results',
    daemon: {
      enabled: false,
      sleepIntervalMs: 60000,
      maxConsecutiveErrors: 10,
      maxCycles: 0,
      recursionLimit: 25,
      stateFilePath: './data/daemon-state.json',
      pauseWindows: [],
      errorBackoffMultiplier: 1.5,
      maxSleepIntervalMs: 300000,
    },
    tunnel: { enabled: false },
    engine: {},
    kibanaConnector: {},
    notifications: {},
    kibanaEval: {},
    elasticsearch: {},
    elasticAgent: {},
    goldenCluster: {},
    edotCollector: {},
    kibanaRepo: {},
  } as unknown as AppConfig;
}

function createMockQueueService(entries: QueueEntry[] = []): QueueService {
  let data = [...entries];
  const statusHistory: { id: string; status: string; errorMessage?: string }[] = [];

  const svc = {
    esClient: {} as unknown as QueueService['esClient'],
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    getQueue: vi.fn(),
    getById: vi.fn().mockImplementation(async (id: string) => data.find((e) => e.id === id) ?? null),
    getCurrent: vi.fn(),
    updateStatus: vi.fn().mockImplementation(async (id: string, status: string, errorMessage?: string) => {
      const entry = data.find((e) => e.id === id);
      if (entry) {
        (entry as any).status = status;
        if (errorMessage) (entry as any).errorMessage = errorMessage;
      }
      statusHistory.push({ id, status, errorMessage });
    }),
    cancel: vi.fn(),
    findPending: vi.fn().mockImplementation(async (limit: number) =>
      data.filter((e) => e.status === 'pending').slice(0, limit)
    ),
    hasPending: vi.fn(),
    shouldAutoStop: vi.fn(),
    getStatusHistory: () => statusHistory,
    getEntries: () => data,
    addEntry: (entry: QueueEntry) => data.push(entry),
  };

  return svc as unknown as QueueService;
}

function createMockVllmEngine(): VllmEngine {
  return {
    engineType: 'vllm' as const,
    deploy: vi.fn(),
    stop: vi.fn().mockResolvedValue(true),
    runBenchmarks: vi.fn(),
    resolveToolCallParser: vi.fn(),
    supportsToolCalling: vi.fn(),
    getApiPort: vi.fn().mockReturnValue(8000),
    getDeploymentLogs: vi.fn(),
    getDeploymentService: vi.fn(),
    getBenchmarkRunner: vi.fn(),
  } as unknown as VllmEngine;
}

function createMockResultsStore(): ElasticsearchResultsStore {
  return {
    esClient: {} as unknown as ElasticsearchResultsStore['esClient'],
    getIndexName: vi.fn().mockReturnValue('benchmarker-results'),
    ensureIndex: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn(),
    query: vi.fn(),
    hasResult: vi.fn().mockResolvedValue(false),
    getEvaluatedModelIds: vi.fn().mockResolvedValue([]),
    getLatestForModel: vi.fn(),
    getModelSummary: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    delete: vi.fn().mockResolvedValue(true),
  } as unknown as ElasticsearchResultsStore;
}

function createMockDeploymentResult(): EngineDeploymentResult {
  return {
    deploymentId: 'dep-1',
    deploymentName: 'vllm-test-model',
    deploymentCommand: 'docker run test',
    modelId: 'test-model',
    toolCallParser: 'hermes',
    parallelismConfig: 4,
    maxModelLen: 8192,
    apiEndpoint: 'http://test-vm:8000',
    timestamp: new Date().toISOString(),
    engineImage: 'vllm/vllm-openai:v0.4.0',
    healthCheckResult: { status: 'available' as const, responseTimeMs: 100 },
    engineType: 'vllm',
    gpuUtilization: null,
  };
}

function createMockBenchmarkResult(): EngineFullBenchmarkResult {
  return {
    modelId: 'test-model',
    runs: [
      {
        concurrencyLevel: 1,
        success: true,
        metrics: {
          itlMs: 10,
          ttftMs: 100,
          throughputTokensPerSec: 500,
          p99LatencyMs: 20,
          concurrencyLevel: 1,
        },
        rawOutput: 'run1 output',
      },
    ],
    combinedRawOutput: 'combined output',
    allSucceeded: true,
    rejectionReasons: [],
    passed: true,
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

describe('Pipeline Integration', () => {
  let config: AppConfig;
  let queueService: ReturnType<typeof createMockQueueService>;
  let vllmEngine: ReturnType<typeof createMockVllmEngine>;
  let resultsStore: ReturnType<typeof createMockResultsStore>;
  let scheduler: Scheduler;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    config = createMockConfig();
    queueService = createMockQueueService();
    vllmEngine = createMockVllmEngine();
    resultsStore = createMockResultsStore();
    originalFetch = global.fetch;
  });

  afterEach(async () => {
    await scheduler.stop();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('happy path', () => {
    it('should poll queue, run full pipeline, and move status to completed', async () => {
      global.fetch = vi.fn().mockImplementation((url: string | URL) => {
        const urlStr = typeof url === 'string' ? url : String(url);
        if (urlStr.includes('/api/models/')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              modelId: 'meta-llama/Llama-3-8B',
              pipeline_tag: 'text-generation',
              tags: ['transformers'],
              id: 'meta-llama/Llama-3-8B',
              siblings: [{ rfilename: 'config.json' }],
            })),
          } as Response);
        }
        if (urlStr.includes('/raw/main/config.json')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              model_type: 'llama',
              architectures: ['LlamaForCausalLM'],
              hidden_size: 4096,
              num_hidden_layers: 32,
              num_attention_heads: 32,
              intermediate_size: 11008,
              max_position_embeddings: 8192,
            })),
          } as Response);
        }
        if (urlStr.includes('/raw/main/README.md') || urlStr.includes('/raw/main/Readme.md')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve('# Llama-3-8B'),
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      vllmEngine.deploy.mockResolvedValue(createMockDeploymentResult());
      vllmEngine.runBenchmarks.mockResolvedValue(createMockBenchmarkResult());

      queueService.addEntry(createQueueEntry());

      const worker = new Stage1WorkerImpl({ config, vllmEngine, resultsStore, queueService });
      scheduler = new Scheduler(queueService, worker, {
        pollIntervalMs: 1000,
        maxConcurrentRuns: 1,
      });

      vi.useFakeTimers();
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(500);

      const statusHistory = (queueService as any).getStatusHistory() as { id: string; status: string; errorMessage?: string }[];
      const finalStatuses = statusHistory.filter((s) => s.id === 'entry-1');

      // Should have transitioned through deploying -> benchmarking -> completed
      expect(finalStatuses.some((s) => s.status === 'completed')).toBe(true);

      // Results stored
      expect(resultsStore.save).toHaveBeenCalledTimes(1);

      // Teardown called
      expect(vllmEngine.stop).toHaveBeenCalled();
    });
  });

  describe('deploy failure', () => {
    it('should move status to failed and not store results when deploy fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          modelId: 'meta-llama/Llama-3-8B',
          pipeline_tag: 'text-generation',
          tags: ['transformers'],
          id: 'meta-llama/Llama-3-8B',
          siblings: [{ rfilename: 'config.json' }],
        })),
      } as Response);

      vllmEngine.deploy.mockRejectedValue(new Error('Deployment timeout'));

      queueService.addEntry(createQueueEntry());

      const worker = new Stage1WorkerImpl({ config, vllmEngine, resultsStore, queueService });
      scheduler = new Scheduler(queueService, worker, {
        pollIntervalMs: 1000,
        maxConcurrentRuns: 1,
      });

      vi.useFakeTimers();
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(500);

      const statusHistory = (queueService as any).getStatusHistory() as { id: string; status: string; errorMessage?: string }[];
      const finalStatuses = statusHistory.filter((s) => s.id === 'entry-1');

      expect(finalStatuses.some((s) => s.status === 'failed')).toBe(true);
      expect(finalStatuses.some((s) => s.errorMessage?.includes('Deployment timeout'))).toBe(true);

      // Results NOT stored
      expect(resultsStore.save).not.toHaveBeenCalled();

      // Teardown NOT called because deploy never returned a deployment object
      expect(vllmEngine.stop).not.toHaveBeenCalled();
    });
  });

  describe('parse retry', () => {
    it('should succeed on second attempt after HF parse fails on first attempt', async () => {
      let parseCallCount = 0;
      vi.spyOn(HFCardParser.prototype, 'parse').mockImplementation(async () => {
        parseCallCount++;
        if (parseCallCount === 1) {
          throw new Error('Temporary HF API blip');
        }
        return {
          card: {
            modelId: 'meta-llama/Llama-3-8B',
            name: 'Llama-3-8B',
            architecture: 'llama',
            contextWindow: 8192,
            parameterCount: 8,
            license: 'llama3',
            quantizations: [],
            supportedTasks: ['text-generation'],
            supportsToolCalling: false,
          },
          vllmFlags: {
            tensorParallelSize: 1,
            trustRemoteCode: false,
            additionalFlags: [],
            gpuMemoryRequiredGb: null,
          },
          warnings: [],
        };
      });

      vllmEngine.deploy.mockResolvedValue(createMockDeploymentResult());
      vllmEngine.runBenchmarks.mockResolvedValue(createMockBenchmarkResult());

      // First entry will fail due to parse throwing on first call
      queueService.addEntry(createQueueEntry({ id: 'entry-1', modelId: 'model-a' }));
      // Second entry will succeed because parse succeeds on second call
      queueService.addEntry(createQueueEntry({ id: 'entry-2', modelId: 'model-a' }));

      const worker = new Stage1WorkerImpl({ config, vllmEngine, resultsStore, queueService });
      scheduler = new Scheduler(queueService, worker, {
        pollIntervalMs: 1000,
        maxConcurrentRuns: 1,
      });

      vi.useFakeTimers();
      await scheduler.start();

      // First poll processes entry-1, parse fails
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(500);

      // Second poll processes entry-2, parse succeeds
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(500);

      const statusHistory = (queueService as any).getStatusHistory() as { id: string; status: string; errorMessage?: string }[];

      // First entry failed
      const entry1Statuses = statusHistory.filter((s) => s.id === 'entry-1');
      expect(entry1Statuses.some((s) => s.status === 'failed')).toBe(true);

      // Second entry completed
      const entry2Statuses = statusHistory.filter((s) => s.id === 'entry-2');
      expect(entry2Statuses.some((s) => s.status === 'completed')).toBe(true);

      // Results stored only once (for the successful second entry)
      expect(resultsStore.save).toHaveBeenCalledTimes(1);
    });
  });
});
