import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Stage3WorkerImpl, type Stage3WorkerDependencies } from '../../src/worker/stage3-worker.js';
import type { PipelineRun, Stage1Result, Stage2Result } from '../../src/scheduler/pipeline-state.js';
import type { AppConfig } from '../../src/types/config.js';
import type { TraceQueryBuilder, TraceSummary } from '../../src/services/trace-query-builder.js';
import type { ReasoningPromptBuilder } from '../../src/services/reasoning-prompt-builder.js';
import type { LlmClient, LlmResponse } from '../../src/services/llm-client.js';
import type { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';

function createMockConfig(): AppConfig {
  return {
    ssh: { host: 'test-vm', port: 22, username: 'testuser', password: 'testpass', useSudo: false },
    huggingfaceToken: 'hf-test-token',
    benchmarkThresholds: {
      minContextWindow: 128000,
      maxITLMs: 20,
      maxITLMsTiers: [],
      maxToolCallLatencyMs: 1000,
      minToolCallSuccessRate: 1.0,
      concurrencyLevels: [1, 4, 16],
      healthCheckTimeoutSeconds: 1200,
    },
    vmHardwareProfile: { gpuType: 'NVIDIA A100', gpuCount: 4, ramGb: 320, cpuCores: 48, diskGb: 1000, machineType: 'a2-ultragpu-2g' },
    hardwareProfileId: '2xa100-80gb',
    logLevel: 'error',
    resultsDir: './results',
    daemon: { enabled: false, sleepIntervalMs: 60000, maxConsecutiveErrors: 10, maxCycles: 0, recursionLimit: 25, stateFilePath: './data/daemon-state.json', pauseWindows: [], errorBackoffMultiplier: 1.5, maxSleepIntervalMs: 300000 },
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
    stage2Thresholds: { maxItlP50Ms: 20, minThroughputTps: 10, maxTtftMs: 5000, minContextWindow: 128000 },
  } as unknown as AppConfig;
}

function createPipelineRun(overrides?: Partial<PipelineRun>): PipelineRun {
  return {
    runId: 'run-1',
    modelId: 'meta-llama/Llama-3-8B',
    queueEntryId: 'entry-1',
    stage: 'benchmark',
    startedAt: new Date().toISOString(),
    hfCard: {
      modelId: 'meta-llama/Llama-3-8B',
      architecture: 'llama',
      contextLength: 8192,
      quantization: ['fp16'],
      tensorParallelSize: 1,
      vllmFlags: ['--trust-remote-code'],
      parsedFrom: { readme: true, configJson: true, generationConfigJson: false },
      warnings: [],
    },
    benchmarkResult: createStage1Result(),
    stage2Result: createStage2Result(),
    ...overrides,
  };
}

function createStage1Result(overrides?: Partial<Stage1Result>): Stage1Result {
  return {
    runId: 'run-1',
    modelId: 'meta-llama/Llama-3-8B',
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

function createStage2Result(overrides?: Partial<Stage2Result>): Stage2Result {
  return {
    runId: 'run-1',
    modelId: 'meta-llama/Llama-3-8B',
    status: 'success',
    scores: { tool_calls: 0.95 },
    suiteResults: [{ suite: 'tool_calls', status: 'success', score: 0.95 }],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createTraceSummary(): TraceSummary {
  return {
    totalSpans: 100,
    errorCount: 2,
    topErrors: [{ operation: 'infer', count: 2, sampleMessage: 'timeout' }],
    latencyPercentiles: { p50_ms: 50, p95_ms: 100, p99_ms: 150 },
    operations: [{ name: 'infer', count: 100, avgDurationMs: 50, errorRate: 0.02 }],
  };
}

function createLlmResponse(content: string): LlmResponse {
  return {
    content,
    finishReason: 'stop',
    model: 'gpt-4o',
  };
}

describe('Stage3WorkerImpl', () => {
  let worker: Stage3WorkerImpl;
  let traceQueryBuilder: TraceQueryBuilder;
  let promptBuilder: ReasoningPromptBuilder;
  let llmClient: LlmClient;
  let resultsStore: ElasticsearchResultsStore;

  beforeEach(() => {
    traceQueryBuilder = {
      buildSummary: vi.fn().mockResolvedValue(createTraceSummary()),
    } as unknown as TraceQueryBuilder;

    promptBuilder = {
      build: vi.fn().mockReturnValue('prompt text'),
    } as unknown as ReasoningPromptBuilder;

    llmClient = {
      complete: vi.fn().mockResolvedValue(
        createLlmResponse(JSON.stringify({
          suggestions: [
            { category: 'config', title: 'Increase max_model_len', description: '...', estimatedImpact: 'high' },
          ],
        })),
      ),
    } as unknown as LlmClient;

    resultsStore = {
      saveReasoningResult: vi.fn().mockResolvedValue(undefined),
    } as unknown as ElasticsearchResultsStore;

    const deps: Stage3WorkerDependencies = {
      config: createMockConfig(),
      traceQueryBuilder,
      promptBuilder,
      llmClient,
      resultsStore,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
    };

    worker = new Stage3WorkerImpl(deps);
  });

  it('success path: all deps happy → returns success result with suggestions', async () => {
    const run = createPipelineRun();

    const result = await worker.execute(run);

    expect(result.status).toBe('success');
    expect(result.runId).toBe('run-1');
    expect(result.modelId).toBe('meta-llama/Llama-3-8B');
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions![0]).toMatchObject({
      category: 'config',
      title: 'Increase max_model_len',
      description: '...',
      estimatedImpact: 'high',
    });
    expect(result.traceSummary).toEqual(createTraceSummary());
    expect(result.rawResponse).toBeDefined();
    expect(result.error).toBeUndefined();

    expect(traceQueryBuilder.buildSummary).toHaveBeenCalledWith(
      'meta-llama/Llama-3-8B',
      'run-1',
      expect.objectContaining({ from: run.startedAt, to: expect.any(String) }),
    );
    expect(promptBuilder.build).toHaveBeenCalledWith({
      pipelineRun: run,
      vllmConfig: run.hfCard,
      stage1Result: run.benchmarkResult,
      stage2Result: run.stage2Result,
      traceSummary: createTraceSummary(),
    });
    expect(llmClient.complete).toHaveBeenCalledWith({
      systemPrompt: 'You are a vLLM performance optimization expert. Return ONLY valid JSON.',
      userPrompt: 'prompt text',
      responseFormat: 'json',
    });
    expect(resultsStore.saveReasoningResult).toHaveBeenCalledOnce();
    const saved = vi.mocked(resultsStore.saveReasoningResult).mock.calls[0]![0];
    expect(saved.status).toBe('success');
  });

  it('trace summary failure: traceQueryBuilder rejects → still returns success (degraded traceSummary)', async () => {
    vi.mocked(traceQueryBuilder.buildSummary).mockRejectedValue(new Error('ES down'));

    const run = createPipelineRun();
    const result = await worker.execute(run);

    expect(result.status).toBe('success');
    expect(result.traceSummary).toBeUndefined();
    expect(result.suggestions).toBeDefined();
    expect(resultsStore.saveReasoningResult).toHaveBeenCalledOnce();
  });

  it('LLM failure: llmClient.complete rejects → returns error result', async () => {
    vi.mocked(llmClient.complete).mockRejectedValue(new Error('LLM timeout'));

    const run = createPipelineRun();
    const result = await worker.execute(run);

    expect(result.status).toBe('error');
    expect(result.error).toBe('LLM timeout');
    expect(result.suggestions).toBeUndefined();
    expect(resultsStore.saveReasoningResult).not.toHaveBeenCalled();
  });

  it('missing hfCard: vllmConfig undefined → promptBuilder still called with undefined', async () => {
    const run = createPipelineRun({ hfCard: undefined });

    await worker.execute(run);

    expect(promptBuilder.build).toHaveBeenCalledWith({
      pipelineRun: run,
      vllmConfig: undefined,
      stage1Result: run.benchmarkResult,
      stage2Result: run.stage2Result,
      traceSummary: createTraceSummary(),
    });
  });

  it('results store failure: saveReasoningResult rejects → still returns success (error swallowed)', async () => {
    vi.mocked(resultsStore.saveReasoningResult).mockRejectedValue(new Error('ES timeout'));

    const run = createPipelineRun();
    const result = await worker.execute(run);

    expect(result.status).toBe('success');
    expect(result.suggestions).toBeDefined();
    expect(resultsStore.saveReasoningResult).toHaveBeenCalledOnce();
  });

  it('JSON parse fallback: extracts JSON from markdown code block', async () => {
    const markdownJson = '```json\n{"suggestions":[{"category":"hardware","title":"Add GPU","description":"...","estimatedImpact":"medium"}]}\n```';
    vi.mocked(llmClient.complete).mockResolvedValue(createLlmResponse(markdownJson));

    const run = createPipelineRun();
    const result = await worker.execute(run);

    expect(result.status).toBe('success');
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions![0]).toMatchObject({
      category: 'hardware',
      title: 'Add GPU',
      description: '...',
      estimatedImpact: 'medium',
    });
  });

  it('handles non-JSON LLM response gracefully → suggestions undefined', async () => {
    vi.mocked(llmClient.complete).mockResolvedValue(createLlmResponse('not json at all'));

    const run = createPipelineRun();
    const result = await worker.execute(run);

    expect(result.status).toBe('success');
    expect(result.suggestions).toBeUndefined();
    expect(result.rawResponse).toBe('not json at all');
  });

  it('validates suggestion fields with defaults for missing/invalid values', async () => {
    vi.mocked(llmClient.complete).mockResolvedValue(
      createLlmResponse(JSON.stringify({
        suggestions: [
          { category: 'unknown', title: 123, description: null, estimatedImpact: 'unknown' },
        ],
      })),
    );

    const run = createPipelineRun();
    const result = await worker.execute(run);

    expect(result.status).toBe('success');
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions![0]).toMatchObject({
      category: 'other',
      title: '123',
      description: '',
      estimatedImpact: 'medium',
    });
  });

  it('NEVER throws from execute', async () => {
    vi.mocked(promptBuilder.build).mockImplementation(() => {
      throw new Error('unexpected');
    });

    const run = createPipelineRun();
    const result = await worker.execute(run);

    expect(result.status).toBe('error');
    expect(result.error).toBe('unexpected');
    expect(result.startedAt).toBeDefined();
    expect(result.completedAt).toBeDefined();
  });
});
