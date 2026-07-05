import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Stage1WorkerImpl,
  type Stage1WorkerDependencies,
} from '../../src/worker/stage1-worker.js';
import type {
  PipelineRun,
  Stage1Result,
  Stage3Result,
} from '../../src/scheduler/pipeline-state.js';
import type {
  AppConfig,
  VMHardwareProfile,
  BenchmarkThresholds,
} from '../../src/types/config.js';
import type { VllmEngine } from '../../src/engines/vllm-engine.js';
import type { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';
import type { QueueService } from '../../src/services/queue-service.js';
import type { EngineDeploymentResult } from '../../src/engines/engine-types.js';
import type {
  BenchmarkMetrics,
} from '../../src/types/benchmark.js';
import type { VllmDeploymentOptions } from '../../src/services/vllm-deployment.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

function createMockConfig(overrides?: Partial<AppConfig>): AppConfig {
  const hardwareProfile: VMHardwareProfile = {
    machineType: 'g2-standard-8',
    gpuType: 'nvidia-l4',
    gpuCount: 1,
    ramGb: 32,
    cpuCores: 4,
    diskGb: 100,
  };

  const thresholds: BenchmarkThresholds = {
    minContextWindow: 8192,
    maxITLMs: 100,
    maxITLMsTiers: [],
    maxToolCallLatencyMs: 1000,
    minToolCallSuccessRate: 1.0,
    concurrencyLevels: [1, 4, 16],
    healthCheckTimeoutSeconds: 1200,
  };

  return {
    ssh: {
      host: 'test-host',
      username: 'test-user',
      password: 'test-pass',
    },
    huggingfaceToken: 'hf_test_token',
    benchmarkThresholds: thresholds,
    vmHardwareProfile: hardwareProfile,
    logLevel: 'error',
    resultsDir: './results',
    daemon: {},
    tunnel: {},
    engine: {},
    kibanaConnector: {},
    notifications: {},
    kibanaEval: {},
    elasticsearch: {},
    elasticAgent: {},
    stage2Thresholds: {
      maxItlP50Ms: 50,
      minThroughputTps: 1000,
      maxTtftMs: 200,
      minContextWindow: 8192,
    },
    enableStage2: false,
    goldenCluster: {},
    edotCollector: {},
    kibanaRepo: {},
    discoveryScheduler: {},
    llmModel: 'gpt-4o',
    llmMaxTokens: 4096,
    llmTemperature: 0.3,
    ...overrides,
  } as AppConfig;
}

function createMockVllmEngine(): VllmEngine {
  const deployResult: EngineDeploymentResult = {
    deploymentId: 'container-123',
    deploymentName: 'vllm-meta-llama-Llama-3-8B',
    deploymentCommand: 'docker run --gpus all vllm/vllm-openai:latest',
    modelId: 'meta-llama/Llama-3-8B',
    toolCallParser: 'llama3_json',
    parallelismConfig: 1,
    maxModelLen: 4096,
    apiEndpoint: 'http://localhost:8000',
    timestamp: new Date().toISOString(),
    engineImage: 'vllm/vllm-openai:latest',
    healthCheckResult: {
      healthy: true,
      totalTimeMs: 1000,
      pollAttempts: 3,
      errorClassification: null,
      containerLogs: null,
      modelInfo: null,
    },
  };

  const metrics: BenchmarkMetrics = {
    itlMs: 10,
    ttftMs: 100,
    throughputTokensPerSec: 1500,
    p99LatencyMs: 50,
    concurrencyLevel: 1,
  };

  return {
    engineType: 'vllm',
    deploy: vi.fn().mockResolvedValue(deployResult),
    stop: vi.fn().mockResolvedValue(true),
    supportsToolCalling: vi.fn().mockReturnValue(true),
    runBenchmarks: vi.fn().mockResolvedValue({
      passed: true,
      runs: [
        {
          concurrencyLevel: 1,
          success: true,
          metrics,
          rawOutput: 'benchmark ok',
        },
      ],
      combinedRawOutput: 'benchmark ok',
      rejectionReasons: [],
    }),
  } as unknown as VllmEngine;
}

function createMockResultsStore(
  reasoningResult?: Stage3Result | null,
): ElasticsearchResultsStore {
  return {
    getLatestReasoningResult: vi.fn().mockResolvedValue(reasoningResult ?? null),
    save: vi.fn().mockResolvedValue(undefined),
  } as unknown as ElasticsearchResultsStore;
}

function createMockQueueService(): QueueService {
  return {
    updateStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as QueueService;
}

function createPipelineRun(): PipelineRun {
  return {
    runId: 'run-001',
    modelId: 'meta-llama/Llama-3-8B',
    queueEntryId: 'queue-001',
    stage: 'idle',
    startedAt: new Date().toISOString(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Stage1WorkerImpl', () => {
  let deps: Stage1WorkerDependencies;
  let worker: Stage1WorkerImpl;

  beforeEach(() => {
    deps = {
      config: createMockConfig(),
      vllmEngine: createMockVllmEngine(),
      resultsStore: createMockResultsStore(),
      queueService: createMockQueueService(),
      // Default to a passing tool-call benchmark so existing perf/eligibility
      // assertions are unaffected by the Stage 2 tool-call gate. Tests that
      // exercise the gate override this per-case.
      toolCallBenchmarkRunner: vi.fn().mockResolvedValue({
        supportsParallelCalls: false,
        maxConcurrentCalls: 1,
        avgToolCallLatencyMs: 50,
        successRate: 1,
        totalTests: 6,
      }),
    };
    worker = new Stage1WorkerImpl(deps);
  });

  describe('feedback loop (Stage 3 → Stage 1)', () => {
    it('should apply deployment overrides when previous reasoning contains vLLM flags', async () => {
      const reasoning: Stage3Result = {
        runId: 'run-prev',
        modelId: 'meta-llama/Llama-3-8B',
        status: 'success',
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
        suggestions: [
          {
            category: 'config',
            title: 'Reduce GPU memory util',
            description:
              'Use --gpu-memory-utilization 0.75 to avoid OOM on this model.',
            estimatedImpact: 'high',
          },
          {
            category: 'config',
            title: 'Raise context length',
            description: 'Set --max-model-len 131072 for full context.',
            estimatedImpact: 'medium',
          },
        ],
      };

      deps.config.stage2Thresholds.minContextWindow = 128_000;
      deps.resultsStore = createMockResultsStore(reasoning);
      worker = new Stage1WorkerImpl(deps);

      await worker.execute(createPipelineRun());

      const deployCall = vi.mocked(deps.vllmEngine.deploy).mock.calls[0];
      expect(deployCall).toBeDefined();
      const overrides = deployCall![3] as VllmDeploymentOptions | undefined;
      expect(overrides).toBeDefined();
      expect(overrides!.gpuMemoryUtilization).toBe(0.75);
      // 131072 >= stage2Thresholds.minContextWindow (128000) → preserved.
      expect(overrides!.maxModelLen).toBe(131072);
    });

    it('should neutralize a reasoning max-model-len below the Stage 2 context floor', async () => {
      const reasoning: Stage3Result = {
        runId: 'run-prev',
        modelId: 'meta-llama/Llama-3-8B',
        status: 'success',
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
        suggestions: [
          {
            category: 'config',
            title: 'Reduce GPU memory util',
            description:
              'Use --gpu-memory-utilization 0.75 to avoid OOM on this model.',
            estimatedImpact: 'high',
          },
          {
            category: 'config',
            title: 'Limit context length',
            description: 'Cap with --max-model-len 8192 for stability.',
            estimatedImpact: 'medium',
          },
        ],
      };

      deps.config.stage2Thresholds.minContextWindow = 128_000;
      deps.resultsStore = createMockResultsStore(reasoning);
      worker = new Stage1WorkerImpl(deps);

      await worker.execute(createPipelineRun());

      const deployCall = vi.mocked(deps.vllmEngine.deploy).mock.calls[0];
      expect(deployCall).toBeDefined();
      const overrides = deployCall![3] as VllmDeploymentOptions | undefined;
      expect(overrides).toBeDefined();
      // gpu-mem-util override is still honored...
      expect(overrides!.gpuMemoryUtilization).toBe(0.75);
      // ...but the sub-floor 8192 max-model-len is dropped (→ vLLM `auto`), so the
      // Stage 2 security eval suites (prompts >8192 tokens) don't 400 on context.
      expect(overrides!.maxModelLen).toBeUndefined();
    });

    it('should pass undefined overrides when previous reasoning has no parseable suggestions', async () => {
      const reasoning: Stage3Result = {
        runId: 'run-prev',
        modelId: 'meta-llama/Llama-3-8B',
        status: 'success',
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
        suggestions: [
          {
            category: 'hardware',
            title: 'Use L4 GPU',
            description: 'L4 is more cost-effective for this workload.',
            estimatedImpact: 'medium',
          },
        ],
      };

      deps.resultsStore = createMockResultsStore(reasoning);
      worker = new Stage1WorkerImpl(deps);

      await worker.execute(createPipelineRun());

      const deployCall = vi.mocked(deps.vllmEngine.deploy).mock.calls[0];
      expect(deployCall).toBeDefined();
      const overrides = deployCall![3] as VllmDeploymentOptions | undefined;
      expect(overrides).toBeUndefined();
    });

    it('should still deploy when getLatestReasoningResult throws (resilience)', async () => {
      deps.resultsStore = {
        getLatestReasoningResult: vi
          .fn()
          .mockRejectedValue(new Error('ES timeout')),
        save: vi.fn().mockResolvedValue(undefined),
      } as unknown as ElasticsearchResultsStore;
      worker = new Stage1WorkerImpl(deps);

      await worker.execute(createPipelineRun());

      expect(deps.vllmEngine.deploy).toHaveBeenCalledTimes(1);
      const deployCall = vi.mocked(deps.vllmEngine.deploy).mock.calls[0];
      const overrides = deployCall![3] as VllmDeploymentOptions | undefined;
      expect(overrides).toBeUndefined();
    });

    it('should pass undefined overrides when no previous reasoning exists', async () => {
      deps.resultsStore = createMockResultsStore(null);
      worker = new Stage1WorkerImpl(deps);

      await worker.execute(createPipelineRun());

      const deployCall = vi.mocked(deps.vllmEngine.deploy).mock.calls[0];
      expect(deployCall).toBeDefined();
      const overrides = deployCall![3] as VllmDeploymentOptions | undefined;
      expect(overrides).toBeUndefined();
    });

    it('should parse --dtype and --max-num-seqs into additionalDockerArgs', async () => {
      const reasoning: Stage3Result = {
        runId: 'run-prev',
        modelId: 'meta-llama/Llama-3-8B',
        status: 'success',
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
        suggestions: [
          {
            category: 'config',
            title: 'Use FP16',
            description: 'Run with --dtype float16 for speed.',
            estimatedImpact: 'medium',
          },
          {
            category: 'config',
            title: 'Limit sequences',
            description: 'Add --max-num-seqs 128.',
            estimatedImpact: 'low',
          },
        ],
      };

      deps.resultsStore = createMockResultsStore(reasoning);
      worker = new Stage1WorkerImpl(deps);

      await worker.execute(createPipelineRun());

      const deployCall = vi.mocked(deps.vllmEngine.deploy).mock.calls[0];
      const overrides = deployCall![3] as VllmDeploymentOptions | undefined;
      expect(overrides).toBeDefined();
      expect(overrides!.additionalDockerArgs).toEqual([
        '--dtype float16',
        '--max-num-seqs 128',
      ]);
    });

    it('should parse --chat-template override', async () => {
      const reasoning: Stage3Result = {
        runId: 'run-prev',
        modelId: 'meta-llama/Llama-3-8B',
        status: 'success',
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
        suggestions: [
          {
            category: 'config',
            title: 'Tool template',
            description:
              'Use --chat-template /data/tool_chat_template_llama3.1_json.jinja',
            estimatedImpact: 'high',
          },
        ],
      };

      deps.resultsStore = createMockResultsStore(reasoning);
      worker = new Stage1WorkerImpl(deps);

      await worker.execute(createPipelineRun());

      const deployCall = vi.mocked(deps.vllmEngine.deploy).mock.calls[0];
      const overrides = deployCall![3] as VllmDeploymentOptions | undefined;
      expect(overrides).toBeDefined();
      expect(overrides!.chatTemplate).toBe(
        '/data/tool_chat_template_llama3.1_json.jinja',
      );
    });
  });

  describe('execute (happy path)', () => {
    it('should return a successful Stage1Result', async () => {
      const result: Stage1Result = await worker.execute(createPipelineRun());

      expect(result.status).toBe('success');
      expect(result.modelId).toBe('meta-llama/Llama-3-8B');
      expect(result.error).toBeUndefined();
    });

    it('should update queue status through the pipeline', async () => {
      await worker.execute(createPipelineRun());

      expect(deps.queueService.updateStatus).toHaveBeenCalledWith(
        'queue-001',
        'deploying',
      );
      expect(deps.queueService.updateStatus).toHaveBeenCalledWith(
        'queue-001',
        'benchmarking',
      );
    });

    it('should save benchmark results to the store', async () => {
      await worker.execute(createPipelineRun());
      expect(deps.resultsStore.save).toHaveBeenCalledTimes(1);
    });

    it('should NOT teardown deployment — scheduler owns teardown', async () => {
      await worker.execute(createPipelineRun());
      expect(deps.vllmEngine.stop).not.toHaveBeenCalled();
    });

    it('should return endpointUrl and deploymentName for scheduler teardown', async () => {
      const result = await worker.execute(createPipelineRun());
      expect(result.endpointUrl).toBe('http://localhost:8000');
      expect(result.deploymentName).toBe('vllm-meta-llama-Llama-3-8B');
    });
  });

  describe('execute (failure handling)', () => {
    it('should handle benchmark failures gracefully', async () => {
      deps.vllmEngine = {
        engineType: 'vllm',
        deploy: vi.fn().mockResolvedValue({
          deploymentId: 'c-1',
          deploymentName: 'vllm-test',
          deploymentCommand: 'docker run',
          modelId: 'meta-llama/Llama-3-8B',
          toolCallParser: null,
          parallelismConfig: 1,
          maxModelLen: 4096,
          apiEndpoint: 'http://localhost:8000',
          timestamp: new Date().toISOString(),
          engineImage: 'vllm:latest',
          healthCheckResult: {
      healthy: true,
      totalTimeMs: 1000,
      pollAttempts: 3,
      errorClassification: null,
      containerLogs: null,
      modelInfo: null,
    },
        }),
        stop: vi.fn().mockResolvedValue(true),
        supportsToolCalling: vi.fn().mockReturnValue(true),
        runBenchmarks: vi.fn().mockRejectedValue(new Error('OOM')),
      } as unknown as VllmEngine;
      worker = new Stage1WorkerImpl(deps);

      const result: Stage1Result = await worker.execute(createPipelineRun());

      expect(result.status).toBe('failed');
      expect(result.error).toContain('OOM');
      expect(deps.queueService.updateStatus).toHaveBeenCalledWith(
        'queue-001',
        'failed',
        expect.stringContaining('OOM'),
      );
    });

    it('should surface rejection reasons as result.error when benchmark completes but does not pass', async () => {
      // Model deploys and benchmarks run to completion but fail the gate
      // (e.g. container crashed at higher concurrency). This path does NOT
      // throw, so without propagating rejectionReasons the queue entry would
      // record error_message: null — a silent failure.
      const metrics: BenchmarkMetrics = {
        itlMs: 10,
        ttftMs: 100,
        throughputTokensPerSec: 1500,
        p99LatencyMs: 50,
        concurrencyLevel: 1,
      };
      deps.vllmEngine = {
        engineType: 'vllm',
        deploy: vi.fn().mockResolvedValue({
          deploymentId: 'c-1',
          deploymentName: 'vllm-test',
          deploymentCommand: 'docker run',
          modelId: 'meta-llama/Llama-3-8B',
          toolCallParser: null,
          parallelismConfig: 1,
          maxModelLen: 4096,
          apiEndpoint: 'http://localhost:8000',
          timestamp: new Date().toISOString(),
          engineImage: 'vllm:latest',
          healthCheckResult: {
            healthy: true,
            totalTimeMs: 1000,
            pollAttempts: 3,
            errorClassification: null,
            containerLogs: null,
            modelInfo: null,
          },
        }),
        stop: vi.fn().mockResolvedValue(true),
        supportsToolCalling: vi.fn().mockReturnValue(true),
        runBenchmarks: vi.fn().mockResolvedValue({
          passed: false,
          runs: [{ concurrencyLevel: 1, success: true, metrics, rawOutput: 'ok' }],
          combinedRawOutput: 'cannot exec in a stopped container',
          rejectionReasons: ['Benchmark failed at concurrency level(s): 4, 16'],
        }),
      } as unknown as VllmEngine;
      worker = new Stage1WorkerImpl(deps);

      const result: Stage1Result = await worker.execute(createPipelineRun());

      expect(result.status).toBe('failed');
      expect(result.error).toContain('concurrency level(s): 4, 16');
    });
  });

  describe('tool-call gate (Stage 2 eligibility)', () => {
    // Neutralize the perf/context gates (deterministic mock metrics already
    // clear ITL/throughput/TTFT; minContextWindow 0 removes the live-HF
    // context dependency) so the tool-call gate is the sole determinant of
    // stage2Eligible.
    beforeEach(() => {
      deps.config = createMockConfig({
        stage2Thresholds: {
          maxItlP50Ms: 50,
          minThroughputTps: 1000,
          maxTtftMs: 200,
          minContextWindow: 0,
        },
      } as Partial<AppConfig>);
      worker = new Stage1WorkerImpl(deps);
    });

    it('marks a model Stage 2 eligible when its tool-call success rate meets the floor', async () => {
      // Default mocks: perf passes + toolCallBenchmarkRunner returns 100% success.
      const result = await worker.execute(createPipelineRun());

      expect(result.status).toBe('success');
      expect(result.stage2Eligible).toBe(true);
      expect(deps.toolCallBenchmarkRunner).toHaveBeenCalledWith('meta-llama/Llama-3-8B');
    });

    it('blocks Stage 2 when the tool-call success rate is below the floor', async () => {
      // 8B model → tier floor 0.9. A 0.5 success rate must gate it out even
      // though the perf benchmark passed.
      deps.toolCallBenchmarkRunner = vi.fn().mockResolvedValue({
        supportsParallelCalls: false,
        maxConcurrentCalls: 1,
        avgToolCallLatencyMs: 50,
        successRate: 0.5,
        totalTests: 6,
      });
      worker = new Stage1WorkerImpl(deps);

      const result = await worker.execute(createPipelineRun());

      // Stage 1 perf still passed (status success), but the model is not
      // promoted to the agentic Stage 2 suites.
      expect(result.status).toBe('success');
      expect(result.stage2Eligible).toBe(false);
      const saved = vi.mocked(deps.resultsStore.save).mock.calls[0]?.[0];
      expect(saved?.toolCallResults?.successRate).toBe(0.5);
    });

    it('fails open (does not gate) when the tool-call benchmark returns null', async () => {
      // A flaky SSH tunnel / infra error surfaces as null — a good model must
      // not be quarantined for it; perf gates alone decide eligibility.
      deps.toolCallBenchmarkRunner = vi.fn().mockResolvedValue(null);
      worker = new Stage1WorkerImpl(deps);

      const result = await worker.execute(createPipelineRun());

      expect(result.status).toBe('success');
      expect(result.stage2Eligible).toBe(true);
      const saved = vi.mocked(deps.resultsStore.save).mock.calls[0]?.[0];
      expect(saved?.toolCallResults).toBeNull();
    });

    it('skips the tool-call benchmark for models that do not advertise tool calling', async () => {
      vi.mocked(deps.vllmEngine.supportsToolCalling).mockReturnValue(false);
      worker = new Stage1WorkerImpl(deps);

      const result = await worker.execute(createPipelineRun());

      expect(deps.toolCallBenchmarkRunner).not.toHaveBeenCalled();
      const saved = vi.mocked(deps.resultsStore.save).mock.calls[0]?.[0];
      expect(saved?.toolCallResults).toBeNull();
      // No tool-call signal → gate is a no-op, perf decides eligibility.
      expect(result.stage2Eligible).toBe(true);
    });
  });
});
