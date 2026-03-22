import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SSHConfig, BenchmarkThresholds } from '../../src/types/config.js';
import type { SSHClientPool, CommandResult } from '../../src/services/ssh-client.js';
import {
  OllamaBenchmarkRunnerService,
  OllamaBenchmarkRunnerError,
} from '../../src/services/ollama-benchmark-runner.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createMockSSHPool(execMock?: typeof vi.fn): SSHClientPool {
  return {
    exec: execMock ?? vi.fn(),
    close: vi.fn(),
  } as unknown as SSHClientPool;
}

function createCommandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command: 'test-command',
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    success: true,
    durationMs: 100,
    ...overrides,
  };
}

const testSSHConfig: SSHConfig = {
  host: '10.0.0.1',
  port: 22,
  username: 'testuser',
  privateKeyPath: '/home/testuser/.ssh/id_rsa',
};

const testThresholds: BenchmarkThresholds = {
  minContextWindow: 128_000,
  maxITLMs: 20,
  maxToolCallLatencyMs: 1000,
  minToolCallSuccessRate: 1.0,
  concurrencyLevels: [1, 4, 16],
  healthCheckTimeoutSeconds: 600,
};

/**
 * Simulates Ollama benchmark output in our structured format
 */
function createOllamaBenchmarkOutput(overrides: {
  itl?: number;
  ttft?: number;
  throughput?: number;
  p99Latency?: number;
  successful?: number;
  failed?: number;
  duration?: number;
  tokens?: number;
} = {}): string {
  const itl = overrides.itl ?? 12.5;
  const ttft = overrides.ttft ?? 45.2;
  const throughput = overrides.throughput ?? 156.3;
  const p99Latency = overrides.p99Latency ?? 35.8;
  const successful = overrides.successful ?? 100;
  const failed = overrides.failed ?? 0;
  const duration = overrides.duration ?? 128.45;
  const tokens = overrides.tokens ?? 12800;

  return [
    '============ Ollama Benchmark Result ============',
    `Successful requests:                     ${successful}`,
    `Failed requests:                         ${failed}`,
    `Benchmark duration (s):                  ${duration}`,
    `Total generated tokens:                  ${tokens}`,
    `Output token throughput (tok/s):          ${throughput}`,
    `Mean TTFT (ms):                          ${ttft}`,
    `Mean ITL (ms):                           ${itl}`,
    `P99 Latency (ms):                        ${p99Latency}`,
    '==================================================',
  ].join('\n');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OllamaBenchmarkRunnerService', () => {
  let service: OllamaBenchmarkRunnerService;
  let mockExec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec = vi.fn();
  });

  describe('constructor', () => {
    it('initializes with default options', () => {
      const pool = createMockSSHPool();
      service = new OllamaBenchmarkRunnerService(pool, 'error');
      expect(service).toBeInstanceOf(OllamaBenchmarkRunnerService);
    });

    it('accepts custom options', () => {
      const pool = createMockSSHPool();
      service = new OllamaBenchmarkRunnerService(pool, 'error', {
        apiPort: 12345,
        numPrompts: 50,
        benchmarkTimeoutMs: 300_000,
      });
      expect(service).toBeInstanceOf(OllamaBenchmarkRunnerService);
    });
  });

  describe('buildBenchmarkScript', () => {
    it('builds a Python benchmark script', () => {
      const pool = createMockSSHPool();
      service = new OllamaBenchmarkRunnerService(pool, 'error');

      const script = service.buildBenchmarkScript('qwen2.5:7b', 4);

      expect(script).toContain('python3');
      expect(script).toContain('asyncio');
      expect(script).toContain('aiohttp');
      expect(script).toContain('qwen2.5:7b');
      expect(script).toContain('11434');
      expect(script).toContain('Ollama Benchmark Result');
    });

    it('uses custom API port', () => {
      const pool = createMockSSHPool();
      service = new OllamaBenchmarkRunnerService(pool, 'error', { apiPort: 12345 });

      const script = service.buildBenchmarkScript('qwen2.5:7b', 1);
      expect(script).toContain('12345');
    });
  });

  describe('parseOllamaBenchmarkOutput', () => {
    it('parses structured benchmark output correctly', () => {
      const pool = createMockSSHPool();
      service = new OllamaBenchmarkRunnerService(pool, 'error');

      const output = createOllamaBenchmarkOutput({
        itl: 15.3,
        ttft: 42.1,
        throughput: 180.5,
        p99Latency: 28.9,
      });

      const metrics = service.parseOllamaBenchmarkOutput(output, 4);

      expect(metrics).not.toBeNull();
      expect(metrics!.itlMs).toBe(15.3);
      expect(metrics!.ttftMs).toBe(42.1);
      expect(metrics!.throughputTokensPerSec).toBe(180.5);
      expect(metrics!.p99LatencyMs).toBe(28.9);
      expect(metrics!.concurrencyLevel).toBe(4);
    });

    it('returns null for unparseable output', () => {
      const pool = createMockSSHPool();
      service = new OllamaBenchmarkRunnerService(pool, 'error');

      const metrics = service.parseOllamaBenchmarkOutput('garbage output', 1);
      expect(metrics).toBeNull();
    });

    it('returns null for empty output', () => {
      const pool = createMockSSHPool();
      service = new OllamaBenchmarkRunnerService(pool, 'error');

      const metrics = service.parseOllamaBenchmarkOutput('', 1);
      expect(metrics).toBeNull();
    });
  });

  describe('runSingleBenchmark', () => {
    it('parses benchmark output successfully', async () => {
      const benchOutput = createOllamaBenchmarkOutput({
        itl: 15.3,
        ttft: 42.1,
        throughput: 180.5,
        p99Latency: 28.9,
      });

      mockExec.mockResolvedValueOnce(
        createCommandResult({
          stdout: benchOutput,
          success: true,
          durationMs: 60_000,
        }),
      );

      const pool = createMockSSHPool(mockExec);
      service = new OllamaBenchmarkRunnerService(pool, 'error');

      const result = await service.runSingleBenchmark(
        testSSHConfig,
        'qwen2.5:7b',
        4,
      );

      expect(result.success).toBe(true);
      expect(result.concurrencyLevel).toBe(4);
      expect(result.metrics.itlMs).toBe(15.3);
      expect(result.metrics.ttftMs).toBe(42.1);
      expect(result.metrics.throughputTokensPerSec).toBe(180.5);
      expect(result.metrics.p99LatencyMs).toBe(28.9);
    });

    it('handles SSH execution failure gracefully', async () => {
      mockExec.mockRejectedValueOnce(new Error('Connection refused'));

      const pool = createMockSSHPool(mockExec);
      service = new OllamaBenchmarkRunnerService(pool, 'error');

      const result = await service.runSingleBenchmark(
        testSSHConfig,
        'qwen2.5:7b',
        1,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSH execution failed');
      expect(result.metrics.itlMs).toBe(0);
    });

    it('handles non-zero exit code with unparseable output', async () => {
      mockExec.mockResolvedValueOnce(
        createCommandResult({
          stdout: 'Fatal error',
          stderr: 'Error: model not found',
          exitCode: 1,
          success: false,
          durationMs: 5_000,
        }),
      );

      const pool = createMockSSHPool(mockExec);
      service = new OllamaBenchmarkRunnerService(pool, 'error');

      const result = await service.runSingleBenchmark(
        testSSHConfig,
        'qwen2.5:7b',
        1,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Benchmark exited with code 1');
    });
  });

  describe('runBenchmarks', () => {
    it('runs benchmarks at multiple concurrency levels', async () => {
      const outputs = [
        createOllamaBenchmarkOutput({ itl: 10, ttft: 30, throughput: 200, p99Latency: 20 }),
        createOllamaBenchmarkOutput({ itl: 12, ttft: 35, throughput: 180, p99Latency: 25 }),
        createOllamaBenchmarkOutput({ itl: 15, ttft: 40, throughput: 150, p99Latency: 30 }),
      ];

      let callIndex = 0;
      mockExec.mockImplementation(() => {
        const output = outputs[callIndex] ?? outputs[0];
        callIndex++;
        return Promise.resolve(
          createCommandResult({
            stdout: output,
            success: true,
            durationMs: 60_000,
          }),
        );
      });

      const pool = createMockSSHPool(mockExec);
      service = new OllamaBenchmarkRunnerService(pool, 'error');

      const result = await service.runBenchmarks(
        testSSHConfig,
        'qwen2.5:7b',
        [1, 4, 16],
        testThresholds,
      );

      expect(result.modelId).toBe('qwen2.5:7b');
      expect(result.runs).toHaveLength(3);
      expect(result.allSucceeded).toBe(true);
      expect(result.combinedRawOutput).toContain('Concurrency Level: 1');
      expect(result.combinedRawOutput).toContain('Concurrency Level: 4');
      expect(result.combinedRawOutput).toContain('Concurrency Level: 16');
    });

    it('passes when all metrics are within thresholds', async () => {
      const output = createOllamaBenchmarkOutput({
        itl: 10,
        ttft: 30,
        throughput: 200,
        p99Latency: 20,
      });

      mockExec.mockResolvedValue(
        createCommandResult({
          stdout: output,
          success: true,
          durationMs: 60_000,
        }),
      );

      const pool = createMockSSHPool(mockExec);
      service = new OllamaBenchmarkRunnerService(pool, 'error');

      const result = await service.runBenchmarks(
        testSSHConfig,
        'qwen2.5:7b',
        [1, 4, 16],
        testThresholds,
      );

      expect(result.passed).toBe(true);
      expect(result.rejectionReasons).toHaveLength(0);
    });

    it('fails when ITL exceeds threshold at concurrency=1', async () => {
      const output = createOllamaBenchmarkOutput({
        itl: 25,
        ttft: 30,
        throughput: 100,
        p99Latency: 50,
      });

      mockExec.mockResolvedValue(
        createCommandResult({
          stdout: output,
          success: true,
          durationMs: 60_000,
        }),
      );

      const pool = createMockSSHPool(mockExec);
      service = new OllamaBenchmarkRunnerService(pool, 'error');

      const result = await service.runBenchmarks(
        testSSHConfig,
        'qwen2.5:7b',
        [1, 4, 16],
        testThresholds,
      );

      expect(result.passed).toBe(false);
      expect(result.rejectionReasons.some((r) => r.includes('ITL'))).toBe(true);
    });

    it('reports failure when no runs succeed', async () => {
      mockExec.mockResolvedValue(
        createCommandResult({
          stdout: 'Fatal error',
          success: false,
          exitCode: 1,
          durationMs: 1_000,
        }),
      );

      const pool = createMockSSHPool(mockExec);
      service = new OllamaBenchmarkRunnerService(pool, 'error');

      const result = await service.runBenchmarks(
        testSSHConfig,
        'qwen2.5:7b',
        [1, 4, 16],
        testThresholds,
      );

      expect(result.allSucceeded).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.rejectionReasons).toContain('No successful benchmark runs completed');
    });
  });

  describe('error classes', () => {
    it('OllamaBenchmarkRunnerError has correct properties', () => {
      const cause = new Error('underlying error');
      const error = new OllamaBenchmarkRunnerError(
        'benchmark failed',
        'model-123',
        4,
        cause,
      );

      expect(error.name).toBe('OllamaBenchmarkRunnerError');
      expect(error.message).toBe('benchmark failed');
      expect(error.modelId).toBe('model-123');
      expect(error.concurrencyLevel).toBe(4);
      expect(error.cause).toBe(cause);
    });
  });
});
