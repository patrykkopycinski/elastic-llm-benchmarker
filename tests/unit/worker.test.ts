import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Stage1WorkerImpl } from '../../src/worker/stage1-worker.js';
import { HFCardParser } from '../../src/services/hf-card-parser.js';
import type { VllmEngine } from '../../src/engines/vllm-engine.js';
import type { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';
import type { QueueService } from '../../src/services/queue-service.js';
import type { AppConfig } from '../../src/types/config.js';
import type { PipelineRun } from '../../src/scheduler/pipeline-state.js';
import type { EngineDeploymentResult, EngineFullBenchmarkResult } from '../../src/engines/engine-types.js';
import type { BenchmarkResult } from '../../src/types/benchmark.js';

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
    findPending: vi.fn(),
    hasPending: vi.fn(),
    shouldAutoStop: vi.fn(),
  } as unknown as QueueService;
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
      {
        concurrencyLevel: 4,
        success: true,
        metrics: {
          itlMs: 12,
          ttftMs: 150,
          throughputTokensPerSec: 1200,
          p99LatencyMs: 25,
          concurrencyLevel: 4,
        },
        rawOutput: 'run2 output',
      },
    ],
    combinedRawOutput: 'combined output',
    allSucceeded: true,
    rejectionReasons: [],
    passed: true,
  };
}

function createPipelineRun(): PipelineRun {
  return {
    runId: 'run-1',
    modelId: 'meta-llama/Llama-3-8B',
    queueEntryId: 'entry-1',
    stage: 'idle',
    startedAt: new Date().toISOString(),
  };
}

describe('Stage1WorkerImpl', () => {
  let config: AppConfig;
  let vllmEngine: ReturnType<typeof createMockVllmEngine>;
  let resultsStore: ReturnType<typeof createMockResultsStore>;
  let queueService: ReturnType<typeof createMockQueueService>;
  let worker: Stage1WorkerImpl;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    config = createMockConfig();
    vllmEngine = createMockVllmEngine();
    resultsStore = createMockResultsStore();
    queueService = createMockQueueService();
    worker = new Stage1WorkerImpl({
      config,
      vllmEngine,
      resultsStore,
      queueService,
    });
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('happy path', () => {
    it('should run full pipeline and store results', async () => {
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

      const run = createPipelineRun();
      const result = await worker.execute(run);

      expect(result.status).toBe('success');
      expect(result.modelId).toBe('meta-llama/Llama-3-8B');

      // Queue status transitions
      expect(queueService.updateStatus).toHaveBeenCalledWith('entry-1', 'deploying');
      expect(queueService.updateStatus).toHaveBeenCalledWith('entry-1', 'benchmarking');
      expect(queueService.updateStatus).toHaveBeenCalledWith('entry-1', 'completed');

      // Deploy and benchmark called
      expect(vllmEngine.deploy).toHaveBeenCalledTimes(1);
      expect(vllmEngine.runBenchmarks).toHaveBeenCalledTimes(1);

      // Results stored
      expect(resultsStore.save).toHaveBeenCalledTimes(1);
      const savedResult = (resultsStore.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as BenchmarkResult;
      expect(savedResult.modelId).toBe('meta-llama/Llama-3-8B');
      expect(savedResult.passed).toBe(true);

      // Teardown called
      expect(vllmEngine.stop).toHaveBeenCalledWith(config.ssh, 'vllm-test-model');
    });
  });

  describe('deploy failure', () => {
    it('should mark run as failed and not store results when deploy throws', async () => {
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

      vllmEngine.deploy.mockRejectedValue(new Error('GPU OOM'));

      const run = createPipelineRun();
      const result = await worker.execute(run);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('GPU OOM');

      // Queue updated to failed
      expect(queueService.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'GPU OOM');

      // Results NOT stored
      expect(resultsStore.save).not.toHaveBeenCalled();

      // Teardown NOT called because deploy never returned a deployment object
      expect(vllmEngine.stop).not.toHaveBeenCalled();
    });
  });

  describe('parse failure', () => {
    it('should mark run as failed when HF card parse throws', async () => {
      vi.spyOn(HFCardParser.prototype, 'parse').mockRejectedValue(
        new Error('HF API rate limited')
      );

      vllmEngine.deploy.mockResolvedValue(createMockDeploymentResult());

      const run = createPipelineRun();
      const result = await worker.execute(run);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('HF API rate limited');

      // Should have updated to deploying, then to failed
      expect(queueService.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', expect.any(String));
      expect(resultsStore.save).not.toHaveBeenCalled();
    });
  });
});
