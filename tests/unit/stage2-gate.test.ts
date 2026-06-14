import { describe, it, expect } from 'vitest';
import { Stage2Gate } from '../../src/worker/stage2-gate.js';
import type { Stage1Result } from '../../src/scheduler/pipeline-state.js';
import type { AppConfig } from '../../src/types/config.js';

function createMockConfig(overrides?: Partial<AppConfig['stage2Thresholds']>): AppConfig {
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
    stage2Thresholds: {
      minItlP50Ms: 20,
      minThroughputTps: 10,
      maxTtftMs: 5000,
      minContextWindow: 128000,
      ...overrides,
    },
  } as unknown as AppConfig;
}

function createStage1Result(metrics: Stage1Result['metrics']): Stage1Result {
  return {
    runId: 'run-1',
    modelId: 'meta-llama/Llama-3-8B',
    queueEntryId: 'entry-1',
    status: 'success',
    metrics,
    rawOutput: '',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

describe('Stage2Gate', () => {
  it('should proceed when all thresholds pass', () => {
    const gate = new Stage2Gate(createMockConfig());
    const result = createStage1Result({
      itl_p50_ms: 100,
      itl_p99_ms: 200,
      ttft_ms: 200,
      throughput_tps: 50,
      duration_sec: 60,
    });

    const decision = gate.check(result);

    expect(decision.proceed).toBe(true);
    expect(decision.reason).toBe('All thresholds passed');
  });

  it('should fail when ITL p50 exceeds maxTtftMs threshold', () => {
    const gate = new Stage2Gate(createMockConfig());
    const result = createStage1Result({
      itl_p50_ms: 5001,
      itl_p99_ms: 6000,
      ttft_ms: 100,
      throughput_tps: 50,
      duration_sec: 60,
    });

    const decision = gate.check(result);

    expect(decision.proceed).toBe(false);
    expect(decision.reason).toContain('ITL p50');
    expect(decision.reason).toContain('5001ms');
    expect(decision.reason).toContain('5000ms');
  });

  it('should fail when throughput is below minThroughputTps', () => {
    const gate = new Stage2Gate(createMockConfig());
    const result = createStage1Result({
      itl_p50_ms: 100,
      itl_p99_ms: 200,
      ttft_ms: 100,
      throughput_tps: 9,
      duration_sec: 60,
    });

    const decision = gate.check(result);

    expect(decision.proceed).toBe(false);
    expect(decision.reason).toContain('Throughput');
    expect(decision.reason).toContain('9 tps');
    expect(decision.reason).toContain('10 tps');
  });

  it('should fail when TTFT exceeds maxTtftMs', () => {
    const gate = new Stage2Gate(createMockConfig());
    const result = createStage1Result({
      itl_p50_ms: 100,
      itl_p99_ms: 200,
      ttft_ms: 5001,
      throughput_tps: 50,
      duration_sec: 60,
    });

    const decision = gate.check(result);

    expect(decision.proceed).toBe(false);
    expect(decision.reason).toContain('TTFT');
    expect(decision.reason).toContain('5001ms');
    expect(decision.reason).toContain('5000ms');
  });

  it('should fail when metrics are null', () => {
    const gate = new Stage2Gate(createMockConfig());
    const result = createStage1Result(null);

    const decision = gate.check(result);

    expect(decision.proceed).toBe(false);
    expect(decision.reason).toBe('No metrics available');
  });

  it('should pass when ITL p50 is exactly at the threshold', () => {
    const gate = new Stage2Gate(createMockConfig());
    const result = createStage1Result({
      itl_p50_ms: 5000,
      itl_p99_ms: 6000,
      ttft_ms: 100,
      throughput_tps: 50,
      duration_sec: 60,
    });

    const decision = gate.check(result);

    expect(decision.proceed).toBe(true);
  });

  it('should pass when throughput is exactly at the threshold', () => {
    const gate = new Stage2Gate(createMockConfig());
    const result = createStage1Result({
      itl_p50_ms: 100,
      itl_p99_ms: 200,
      ttft_ms: 100,
      throughput_tps: 10,
      duration_sec: 60,
    });

    const decision = gate.check(result);

    expect(decision.proceed).toBe(true);
  });

  it('should pass when TTFT is exactly at the threshold', () => {
    const gate = new Stage2Gate(createMockConfig());
    const result = createStage1Result({
      itl_p50_ms: 100,
      itl_p99_ms: 200,
      ttft_ms: 5000,
      throughput_tps: 50,
      duration_sec: 60,
    });

    const decision = gate.check(result);

    expect(decision.proceed).toBe(true);
  });

  it('should use custom threshold overrides', () => {
    const gate = new Stage2Gate(
      createMockConfig({ maxTtftMs: 100, minThroughputTps: 100 }),
    );
    const result = createStage1Result({
      itl_p50_ms: 50,
      itl_p99_ms: 70,
      ttft_ms: 80,
      throughput_tps: 150,
      duration_sec: 60,
    });

    const decision = gate.check(result);

    expect(decision.proceed).toBe(true);
  });

  it('should fail with custom threshold overrides when TTFT exceeds overridden value', () => {
    const gate = new Stage2Gate(
      createMockConfig({ maxTtftMs: 100 }),
    );
    const result = createStage1Result({
      itl_p50_ms: 50,
      itl_p99_ms: 70,
      ttft_ms: 101,
      throughput_tps: 150,
      duration_sec: 60,
    });

    const decision = gate.check(result);

    expect(decision.proceed).toBe(false);
    expect(decision.reason).toContain('101ms');
    expect(decision.reason).toContain('100ms');
  });
});
