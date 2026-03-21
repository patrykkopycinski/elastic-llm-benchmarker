import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SSHConfig, BenchmarkThresholds } from '../../src/types/config.js';
import type { CommandResult, SSHClientPool } from '../../src/services/ssh-client.js';
import {
  BenchmarkRunnerService,
  BenchmarkRunnerError,
} from '../../src/services/benchmark-runner.js';

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
 * Simulates vllm bench serve output in the standard format
 */
function createBenchmarkOutput(overrides: {
  itl?: number;
  ttft?: number;
  throughput?: number;
  p99Latency?: number;
} = {}): string {
  const itl = overrides.itl ?? 12.5;
  const ttft = overrides.ttft ?? 45.2;
  const throughput = overrides.throughput ?? 156.3;
  const p99Latency = overrides.p99Latency ?? 35.8;

  return [
    '============ Serving Benchmark Result ============',
    `Successful requests:                     200`,
    `Benchmark duration (s):                  128.45`,
    `Total input tokens:                      51200`,
    `Total generated tokens:                  25600`,
    `Request throughput (req/s):              1.56`,
    `Output token throughput (tok/s):          ${throughput}`,
    `Total Token throughput (tok/s):           312.6`,
    `---------------Time to First Token----------------`,
    `Mean TTFT (ms):                          ${ttft}`,
    `Median TTFT (ms):                        40.1`,
    `P99 TTFT (ms):                           89.3`,
    `-----Time per Output Token (Excluding 1st Token)---`,
    `Mean ITL (ms):                           ${itl}`,
    `Median ITL (ms):                         10.8`,
    `P99 ITL (ms):                            ${p99Latency}`,
    `==================================================`,
  ].join('\n');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BenchmarkRunnerService', () => {
  let service: BenchmarkRunnerService;
  let mockExec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec = vi.fn();
  });

  describe('constructor', () => {
    it('initializes with default options', () => {
      const pool = createMockSSHPool();
      service = new BenchmarkRunnerService(pool, 'error');
      expect(service).toBeInstanceOf(BenchmarkRunnerService);
    });

    it('accepts custom options', () => {
      const pool = createMockSSHPool();
      service = new BenchmarkRunnerService(pool, 'error', {
        apiPort: 9000,
        numPrompts: 100,
        benchmarkTimeoutMs: 300_000,
        dataset: 'random',
      });
      expect(service).toBeInstanceOf(BenchmarkRunnerService);
    });
  });

  describe('buildBenchmarkCommand', () => {
    it('builds a correct vllm bench serve command', () => {
      const pool = createMockSSHPool();
      service = new BenchmarkRunnerService(pool, 'error');

      const command = service.buildBenchmarkCommand(
        'meta-llama/Llama-3-70B-Instruct',
        4,
      );

      expect(command).toContain('vllm bench serve');
      expect(command).toContain('--base-url http://localhost:8000/v1');
      expect(command).toContain('--model meta-llama/Llama-3-70B-Instruct');
      expect(command).toContain('--num-prompts 200');
      expect(command).toContain('--max-concurrency 4');
      expect(command).toContain('--random-output-len 128');
      expect(command).toContain('--random-input-len 256');
    });

    it('uses custom API port', () => {
      const pool = createMockSSHPool();
      service = new BenchmarkRunnerService(pool, 'error', { apiPort: 9000 });

      const command = service.buildBenchmarkCommand('test-model', 1);
      expect(command).toContain('--base-url http://localhost:9000/v1');
    });

    it('uses custom number of prompts', () => {
      const pool = createMockSSHPool();
      service = new BenchmarkRunnerService(pool, 'error', { numPrompts: 100 });

      const command = service.buildBenchmarkCommand('test-model', 1);
      expect(command).toContain('--num-prompts 100');
    });

    it('uses custom random output and input lengths', () => {
      const pool = createMockSSHPool();
      service = new BenchmarkRunnerService(pool, 'error', {
        randomOutputLen: 256,
        randomInputLen: 512,
      });

      const command = service.buildBenchmarkCommand('test-model', 1);
      expect(command).toContain('--random-output-len 256');
      expect(command).toContain('--random-input-len 512');
    });
  });

  describe('runSingleBenchmark', () => {
    it('parses benchmark output successfully', async () => {
      const benchOutput = createBenchmarkOutput({
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
      service = new BenchmarkRunnerService(pool, 'error');

      const result = await service.runSingleBenchmark(
        testSSHConfig,
        'meta-llama/Llama-3-70B-Instruct',
        4,
      );

      expect(result.success).toBe(true);
      expect(result.concurrencyLevel).toBe(4);
      expect(result.metrics.itlMs).toBe(15.3);
      expect(result.metrics.ttftMs).toBe(42.1);
      expect(result.metrics.throughputTokensPerSec).toBe(180.5);
      expect(result.metrics.p99LatencyMs).toBe(28.9);
      expect(result.metrics.concurrencyLevel).toBe(4);
      expect(result.durationMs).toBe(60_000);
      expect(result.rawOutput).toContain('Serving Benchmark Result');
    });

    it('handles SSH execution failure gracefully', async () => {
      mockExec.mockRejectedValueOnce(new Error('Connection refused'));

      const pool = createMockSSHPool(mockExec);
      service = new BenchmarkRunnerService(pool, 'error');

      const result = await service.runSingleBenchmark(
        testSSHConfig,
        'test-model',
        1,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSH execution failed');
      expect(result.error).toContain('Connection refused');
      expect(result.metrics.itlMs).toBe(0);
      expect(result.metrics.throughputTokensPerSec).toBe(0);
    });

    it('handles non-zero exit code with parseable output', async () => {
      const benchOutput = createBenchmarkOutput({
        itl: 18.0,
        ttft: 50.0,
        throughput: 120.0,
        p99Latency: 40.0,
      });

      mockExec.mockResolvedValueOnce(
        createCommandResult({
          stdout: benchOutput,
          stderr: 'Warning: some deprecation notice',
          exitCode: 1,
          success: false,
          durationMs: 45_000,
        }),
      );

      const pool = createMockSSHPool(mockExec);
      service = new BenchmarkRunnerService(pool, 'error');

      const result = await service.runSingleBenchmark(
        testSSHConfig,
        'test-model',
        1,
      );

      // Should succeed since output was parseable
      expect(result.success).toBe(true);
      expect(result.metrics.itlMs).toBe(18.0);
      expect(result.metrics.throughputTokensPerSec).toBe(120.0);
    });

    it('handles non-zero exit code with unparseable output', async () => {
      mockExec.mockResolvedValueOnce(
        createCommandResult({
          stdout: 'Fatal error: model not found',
          stderr: 'Error: cannot load model',
          exitCode: 1,
          success: false,
          durationMs: 5_000,
        }),
      );

      const pool = createMockSSHPool(mockExec);
      service = new BenchmarkRunnerService(pool, 'error');

      const result = await service.runSingleBenchmark(
        testSSHConfig,
        'test-model',
        1,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Benchmark exited with code 1');
    });

    it('handles successful exit with unparseable output', async () => {
      mockExec.mockResolvedValueOnce(
        createCommandResult({
          stdout: 'Running benchmark...\nDone.\n',
          success: true,
          durationMs: 30_000,
        }),
      );

      const pool = createMockSSHPool(mockExec);
      service = new BenchmarkRunnerService(pool, 'error');

      const result = await service.runSingleBenchmark(
        testSSHConfig,
        'test-model',
        1,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to parse output');
    });
  });

  describe('runBenchmarks', () => {
    it('runs benchmarks at multiple concurrency levels', async () => {
      const outputs = [
        createBenchmarkOutput({ itl: 10, ttft: 30, throughput: 200, p99Latency: 20 }),
        createBenchmarkOutput({ itl: 12, ttft: 35, throughput: 180, p99Latency: 25 }),
        createBenchmarkOutput({ itl: 15, ttft: 40, throughput: 150, p99Latency: 30 }),
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
      service = new BenchmarkRunnerService(pool, 'error');

      const result = await service.runBenchmarks(
        testSSHConfig,
        'meta-llama/Llama-3-70B-Instruct',
        [1, 4, 16],
        testThresholds,
      );

      expect(result.modelId).toBe('meta-llama/Llama-3-70B-Instruct');
      expect(result.runs).toHaveLength(3);
      expect(result.allSucceeded).toBe(true);
      expect(result.runs[0]!.concurrencyLevel).toBe(1);
      expect(result.runs[1]!.concurrencyLevel).toBe(4);
      expect(result.runs[2]!.concurrencyLevel).toBe(16);
      expect(result.combinedRawOutput).toContain('Concurrency Level: 1');
      expect(result.combinedRawOutput).toContain('Concurrency Level: 4');
      expect(result.combinedRawOutput).toContain('Concurrency Level: 16');
      expect(mockExec).toHaveBeenCalledTimes(3);
    });

    it('passes when all metrics are within thresholds', async () => {
      const output = createBenchmarkOutput({
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
      service = new BenchmarkRunnerService(pool, 'error');

      const result = await service.runBenchmarks(
        testSSHConfig,
        'test-model',
        [1, 4, 16],
        testThresholds,
      );

      expect(result.passed).toBe(true);
      expect(result.rejectionReasons).toHaveLength(0);
    });

    it('fails when ITL exceeds threshold at concurrency=1', async () => {
      // ITL of 25ms exceeds the 20ms threshold
      const output = createBenchmarkOutput({
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
      service = new BenchmarkRunnerService(pool, 'error');

      const result = await service.runBenchmarks(
        testSSHConfig,
        'test-model',
        [1, 4, 16],
        testThresholds,
      );

      expect(result.passed).toBe(false);
      expect(result.rejectionReasons.some((r) => r.includes('ITL'))).toBe(true);
    });

    it('fails when P99 latency exceeds threshold', async () => {
      // P99 of 250ms exceeds 10x ITL threshold (20 * 10 = 200ms)
      const output = createBenchmarkOutput({
        itl: 10,
        ttft: 30,
        throughput: 200,
        p99Latency: 250,
      });

      mockExec.mockResolvedValue(
        createCommandResult({
          stdout: output,
          success: true,
          durationMs: 60_000,
        }),
      );

      const pool = createMockSSHPool(mockExec);
      service = new BenchmarkRunnerService(pool, 'error');

      const result = await service.runBenchmarks(
        testSSHConfig,
        'test-model',
        [1, 4, 16],
        testThresholds,
      );

      expect(result.passed).toBe(false);
      expect(result.rejectionReasons.some((r) => r.includes('P99'))).toBe(true);
    });

    it('reports failure when some runs fail', async () => {
      let callIndex = 0;
      mockExec.mockImplementation(() => {
        callIndex++;
        if (callIndex === 2) {
          // Second call (concurrency=4) fails
          return Promise.resolve(
            createCommandResult({
              stdout: 'Error: connection refused',
              success: false,
              exitCode: 1,
              durationMs: 1_000,
            }),
          );
        }
        return Promise.resolve(
          createCommandResult({
            stdout: createBenchmarkOutput({
              itl: 10,
              ttft: 30,
              throughput: 200,
              p99Latency: 20,
            }),
            success: true,
            durationMs: 60_000,
          }),
        );
      });

      const pool = createMockSSHPool(mockExec);
      service = new BenchmarkRunnerService(pool, 'error');

      const result = await service.runBenchmarks(
        testSSHConfig,
        'test-model',
        [1, 4, 16],
        testThresholds,
      );

      expect(result.allSucceeded).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.rejectionReasons.some((r) => r.includes('concurrency level'))).toBe(true);
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
      service = new BenchmarkRunnerService(pool, 'error');

      const result = await service.runBenchmarks(
        testSSHConfig,
        'test-model',
        [1, 4, 16],
        testThresholds,
      );

      expect(result.allSucceeded).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.rejectionReasons).toContain('No successful benchmark runs completed');
    });
  });

  describe('error classes', () => {
    it('BenchmarkRunnerError has correct properties', () => {
      const cause = new Error('underlying error');
      const error = new BenchmarkRunnerError(
        'benchmark failed',
        'model-123',
        4,
        cause,
      );

      expect(error.name).toBe('BenchmarkRunnerError');
      expect(error.message).toBe('benchmark failed');
      expect(error.modelId).toBe('model-123');
      expect(error.concurrencyLevel).toBe(4);
      expect(error.cause).toBe(cause);
    });
  });
});
