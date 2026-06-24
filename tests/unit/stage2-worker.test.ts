import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Stage2WorkerImpl, type Stage2WorkerDependencies } from '../../src/worker/stage2-worker.js';
import type { PipelineRun, Stage1Result, Stage2Result } from '../../src/scheduler/pipeline-state.js';
import type { AppConfig } from '../../src/types/config.js';
import type { Stage2Gate } from '../../src/worker/stage2-gate.js';
import type { KibanaRepoService } from '../../src/services/kibana-repo-service.js';
import type { EvalSuiteRunner } from '../../src/services/eval-suite-runner.js';
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
    deployment: {
      deploymentName: 'deploy-1',
      containerId: 'abc123',
      endpointUrl: 'http://localhost:8000',
      status: 'deployed',
    },
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

describe('Stage2WorkerImpl', () => {
  let worker: Stage2WorkerImpl;
  let gate: Stage2Gate;
  let repoService: KibanaRepoService;
  let evalRunner: EvalSuiteRunner;
  let resultsStore: ElasticsearchResultsStore;

  beforeEach(() => {
    gate = {
      check: vi.fn(),
    } as unknown as Stage2Gate;

    repoService = {
      cloneOrPull: vi.fn().mockResolvedValue(undefined),
      bootstrap: vi.fn().mockResolvedValue(undefined),
      getRepoPath: vi.fn().mockReturnValue('/tmp/kibana'),
    } as unknown as KibanaRepoService;

    evalRunner = {
      run: vi.fn(),
    } as unknown as EvalSuiteRunner;

    resultsStore = {
      saveStage2Result: vi.fn().mockResolvedValue(undefined),
    } as unknown as ElasticsearchResultsStore;

    const deps: Stage2WorkerDependencies = {
      config: createMockConfig(),
      gate,
      repoService,
      evalRunner,
      resultsStore,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
    };

    worker = new Stage2WorkerImpl(deps);
  });

  it('returns skipped when gate blocks', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: false, reason: 'ITL too high' });

    const run = createPipelineRun();
    const stage1 = createStage1Result();

    const result = await worker.execute(run, stage1);

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('ITL too high');
    expect(gate.check).toHaveBeenCalledWith(stage1);
    expect(repoService.cloneOrPull).not.toHaveBeenCalled();
    expect(resultsStore.saveStage2Result).not.toHaveBeenCalled();
  });

  it('returns failed when no deployment endpoint exists', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: true, reason: 'All thresholds passed' });

    const run = createPipelineRun({ deployment: undefined });
    const stage1 = createStage1Result();

    const result = await worker.execute(run, stage1);

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('No deployment endpoint');
    expect(repoService.cloneOrPull).not.toHaveBeenCalled();
    expect(resultsStore.saveStage2Result).not.toHaveBeenCalled();
  });

  it('returns full success path', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: true, reason: 'All thresholds passed' });
    vi.mocked(evalRunner.run).mockResolvedValue({
      modelId: 'meta-llama/Llama-3-8B',
      endpointUrl: 'http://localhost:8000',
      status: 'success',
      suiteResults: [
        { suite: 'tool_calls', status: 'pass', score: 0.95, durationMs: 1200 },
        { suite: 'latency', status: 'pass', score: 0.88, durationMs: 900 },
      ],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const run = createPipelineRun();
    const stage1 = createStage1Result();

    const result = await worker.execute(run, stage1);

    expect(result.status).toBe('success');
    expect(result.scores).toEqual({ tool_calls: 0.95, latency: 0.88 });
    expect(result.suiteResults).toEqual([
      { suite: 'tool_calls', status: 'pass', score: 0.95, error: undefined },
      { suite: 'latency', status: 'pass', score: 0.88, error: undefined },
    ]);
    expect(repoService.cloneOrPull).toHaveBeenCalled();
    expect(repoService.bootstrap).toHaveBeenCalled();
    expect(evalRunner.run).toHaveBeenCalledWith({
      repoPath: '/tmp/kibana',
      endpointUrl: 'http://localhost:8000',
      modelId: 'meta-llama/Llama-3-8B',
    });
    expect(resultsStore.saveStage2Result).toHaveBeenCalledOnce();
    const saved = vi.mocked(resultsStore.saveStage2Result).mock.calls[0]![0] as Stage2Result;
    expect(saved.runId).toBe('run-1');
    expect(saved.modelId).toBe('meta-llama/Llama-3-8B');
    expect(saved.status).toBe('success');
    expect(saved.scores).toEqual({ tool_calls: 0.95, latency: 0.88 });
  });

  it('returns success for eval partial status', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: true, reason: 'All thresholds passed' });
    vi.mocked(evalRunner.run).mockResolvedValue({
      modelId: 'meta-llama/Llama-3-8B',
      endpointUrl: 'http://localhost:8000',
      status: 'partial',
      suiteResults: [
        { suite: 'tool_calls', status: 'pass', score: 0.9, durationMs: 1200 },
        { suite: 'latency', status: 'error', durationMs: 0, error: 'timeout' },
      ],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const run = createPipelineRun();
    const stage1 = createStage1Result();

    const result = await worker.execute(run, stage1);

    expect(result.status).toBe('success');
    expect(result.scores).toEqual({ tool_calls: 0.9 });
    expect(result.suiteResults).toEqual([
      { suite: 'tool_calls', status: 'pass', score: 0.9, error: undefined },
      { suite: 'latency', status: 'error', score: undefined, error: 'timeout' },
    ]);
    expect(resultsStore.saveStage2Result).toHaveBeenCalledOnce();
  });

  it('returns failed for eval failed status', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: true, reason: 'All thresholds passed' });
    vi.mocked(evalRunner.run).mockResolvedValue({
      modelId: 'meta-llama/Llama-3-8B',
      endpointUrl: 'http://localhost:8000',
      status: 'failed',
      suiteResults: [
        { suite: 'tool_calls', status: 'fail', durationMs: 0, error: 'crash' },
      ],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const run = createPipelineRun();
    const stage1 = createStage1Result();

    const result = await worker.execute(run, stage1);

    expect(result.status).toBe('failed');
    expect(resultsStore.saveStage2Result).toHaveBeenCalledOnce();
    const saved = vi.mocked(resultsStore.saveStage2Result).mock.calls[0]![0] as Stage2Result;
    expect(saved.status).toBe('failed');
  });

  it('returns error status on repo bootstrap failure', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: true, reason: 'All thresholds passed' });
    vi.mocked(repoService.cloneOrPull).mockRejectedValue(new Error('git clone failed'));

    const run = createPipelineRun();
    const stage1 = createStage1Result();

    const result = await worker.execute(run, stage1);

    expect(result.status).toBe('error');
    expect(result.reason).toBe('git clone failed');
    expect(evalRunner.run).not.toHaveBeenCalled();
    expect(resultsStore.saveStage2Result).not.toHaveBeenCalled();
  });

  it('does not throw and always returns a Stage2Result', async () => {
    vi.mocked(gate.check).mockImplementation(() => {
      throw new Error('unexpected gate error');
    });

    const run = createPipelineRun();
    const stage1 = createStage1Result();

    const result = await worker.execute(run, stage1);

    expect(result.status).toBe('error');
    expect(result.reason).toBe('unexpected gate error');
    expect(resultsStore.saveStage2Result).not.toHaveBeenCalled();
  });

  it('swallows ES save error and still returns result', async () => {
    vi.mocked(gate.check).mockReturnValue({ proceed: true, reason: 'All thresholds passed' });
    vi.mocked(evalRunner.run).mockResolvedValue({
      modelId: 'meta-llama/Llama-3-8B',
      endpointUrl: 'http://localhost:8000',
      status: 'success',
      suiteResults: [
        { suite: 'tool_calls', status: 'pass', score: 0.95, durationMs: 1200 },
      ],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    vi.mocked(resultsStore.saveStage2Result).mockRejectedValue(new Error('ES timeout'));

    const run = createPipelineRun();
    const stage1 = createStage1Result();

    const result = await worker.execute(run, stage1);

    expect(result.status).toBe('success');
    expect(result.scores).toEqual({ tool_calls: 0.95 });
    expect(resultsStore.saveStage2Result).toHaveBeenCalledOnce();
  });
});
