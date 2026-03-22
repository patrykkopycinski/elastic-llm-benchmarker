import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SSHConfig } from '../../src/types/config.js';
import type { CommandResult, SSHClientPool } from '../../src/services/ssh-client.js';
import {
  HealthCheckService,
  HealthCheckServiceError,
} from '../../src/services/health-check.js';
import type {
  HealthCheckErrorClassification,
  HealthCheckResult,
} from '../../src/services/health-check.js';

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('HealthCheckService', () => {
  let service: HealthCheckService;
  let mockExec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec = vi.fn();
  });

  describe('constructor', () => {
    it('initializes with default options', () => {
      const pool = createMockSSHPool();
      service = new HealthCheckService(pool, 'error');
      expect(service).toBeInstanceOf(HealthCheckService);
    });

    it('accepts custom options', () => {
      const pool = createMockSSHPool();
      service = new HealthCheckService(pool, 'error', {
        timeoutMs: 300_000,
        intervalMs: 5_000,
        apiPort: 9000,
        logTailLines: 100,
        commandTimeoutMs: 5_000,
      });
      expect(service).toBeInstanceOf(HealthCheckService);
    });
  });

  describe('classifyContainerLogs', () => {
    beforeEach(() => {
      const pool = createMockSSHPool();
      service = new HealthCheckService(pool, 'error');
    });

    // OOM errors
    it('classifies CUDA out of memory errors', () => {
      const logs = 'Loading model weights...\nCUDA out of memory. Tried to allocate 2.00 GiB\nProcess killed';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('oom');
      expect(result!.isFatal).toBe(true);
      expect(result!.matchedLogLines).toHaveLength(1);
      expect(result!.matchedLogLines[0]).toContain('CUDA out of memory');
    });

    it('classifies torch OutOfMemoryError', () => {
      const logs = 'torch.cuda.OutOfMemoryError: CUDA out of memory';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('oom');
      expect(result!.isFatal).toBe(true);
    });

    it('classifies generic OOM errors', () => {
      const logs = 'MemoryError: Unable to allocate array';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('oom');
    });

    it('classifies KV cache allocation errors', () => {
      const logs = 'KV cache is too large for available memory';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('oom');
      expect(result!.recommendation).toContain('max-model-len');
    });

    // CUDA errors
    it('classifies CUDA device errors', () => {
      const logs = 'CUDA error: device-side assert triggered';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('cuda_error');
      expect(result!.isFatal).toBe(true);
    });

    it('classifies NCCL errors', () => {
      const logs = 'NCCL error: unhandled system error\nncclSystemError';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('cuda_error');
      expect(result!.recommendation).toContain('tensor-parallel-size');
    });

    it('classifies CUDA runtime errors', () => {
      const logs = 'RuntimeError: CUDA error: no CUDA-capable device is detected';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('cuda_error');
    });

    it('classifies no CUDA-capable device errors', () => {
      const logs = 'no CUDA-capable device is detected\nCheck NVIDIA drivers';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('cuda_error');
    });

    // Gated repo errors
    it('classifies gated repo access errors', () => {
      const logs = 'Access to model meta-llama/Llama-3-70B is restricted';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('gated_repo');
      expect(result!.isFatal).toBe(true);
      expect(result!.recommendation).toContain('HF_TOKEN');
    });

    it('classifies gated repository errors', () => {
      const logs = 'Cannot access gated repo for model meta-llama/Llama-3-70B';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('gated_repo');
    });

    it('classifies invalid token errors', () => {
      const logs = 'Invalid token or token expired for huggingface';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('gated_repo');
    });

    // Architecture not supported
    it('classifies unsupported architecture errors', () => {
      const logs = 'ValueError: not supported architecture for this model type';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('architecture_not_supported');
      expect(result!.isFatal).toBe(true);
    });

    it('classifies KeyError model loading errors', () => {
      const logs = "KeyError: 'CustomModelForCausalLM'";
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('architecture_not_supported');
    });

    it('classifies NotImplementedError for architectures', () => {
      const logs = 'NotImplementedError: this architecture is not yet supported';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('architecture_not_supported');
    });

    // Model not found
    it('classifies model not found errors', () => {
      const logs = 'Error: model not-real/model not found (404)';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('model_not_found');
    });

    it('classifies OSError for invalid models', () => {
      const logs = "OSError: not a valid model identifier: 'invalid-model'";
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('model_not_found');
    });

    // Disk space
    it('classifies disk space errors', () => {
      const logs = 'No space left on device';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('disk_space');
      expect(result!.isFatal).toBe(true);
    });

    // Network errors
    it('classifies network errors', () => {
      const logs = 'ConnectionError: unable to reach huggingface.co';
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.category).toBe('network_error');
    });

    // No match
    it('returns null for normal log output', () => {
      const logs = 'INFO: Starting vLLM server\nINFO: Loading model weights\nINFO: Model loaded successfully';
      const result = service.classifyContainerLogs(logs);

      expect(result).toBeNull();
    });

    it('returns null for empty logs', () => {
      const result = service.classifyContainerLogs('');
      expect(result).toBeNull();
    });

    it('limits matched log lines to 5', () => {
      const logs = Array(10).fill('CUDA out of memory. Tried to allocate memory').join('\n');
      const result = service.classifyContainerLogs(logs);

      expect(result).not.toBeNull();
      expect(result!.matchedLogLines).toHaveLength(5);
    });
  });

  describe('poll', () => {
    it('returns healthy when both endpoints respond', async () => {
      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        // docker inspect
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'true', success: true }));
        }
        // /health
        if (command.includes('/health')) {
          return Promise.resolve(createCommandResult({ stdout: 'OK', success: true }));
        }
        // /v1/models
        if (command.includes('/v1/models')) {
          return Promise.resolve(
            createCommandResult({
              stdout: JSON.stringify({ data: [{ id: 'test-model', max_model_len: 128000 }] }),
              success: true,
            }),
          );
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new HealthCheckService(pool, 'error');

      const result = await service.poll(testSSHConfig, 'test-container', 'test-model', 5000);

      expect(result.healthy).toBe(true);
      expect(result.healthEndpointOk).toBe(true);
      expect(result.modelsEndpointOk).toBe(true);
      expect(result.containerRunning).toBe(true);
      expect(result.errorClassification).toBeNull();
    });

    it('returns healthy when /health passes but /v1/models is not ready', async () => {
      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'true', success: true }));
        }
        if (command.includes('/health')) {
          return Promise.resolve(createCommandResult({ stdout: 'OK', success: true }));
        }
        if (command.includes('/v1/models')) {
          return Promise.resolve(createCommandResult({ success: false }));
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new HealthCheckService(pool, 'error');

      const result = await service.poll(testSSHConfig, 'test-container', 'test-model', 5000);

      expect(result.healthy).toBe(true);
      expect(result.healthEndpointOk).toBe(true);
      expect(result.modelsEndpointOk).toBe(false);
    });

    it('detects crashed container and classifies logs', async () => {
      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'false', success: true }));
        }
        if (command.includes('docker logs')) {
          return Promise.resolve(
            createCommandResult({
              stdout: 'CUDA out of memory. Tried to allocate 2.00 GiB',
              success: true,
            }),
          );
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new HealthCheckService(pool, 'error');

      const result = await service.poll(testSSHConfig, 'test-container', 'test-model', 5000);

      expect(result.healthy).toBe(false);
      expect(result.containerRunning).toBe(false);
      expect(result.errorClassification).not.toBeNull();
      expect(result.errorClassification!.category).toBe('oom');
      expect(result.errorClassification!.isFatal).toBe(true);
    });

    it('returns not healthy when container running but endpoints not ready (before 60s)', async () => {
      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'true', success: true }));
        }
        if (command.includes('/health')) {
          return Promise.resolve(createCommandResult({ success: false, stderr: 'Connection refused' }));
        }
        if (command.includes('/v1/models')) {
          return Promise.resolve(createCommandResult({ success: false }));
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new HealthCheckService(pool, 'error');

      // elapsedMs < 60s so logs won't be checked
      const result = await service.poll(testSSHConfig, 'test-container', 'test-model', 30_000);

      expect(result.healthy).toBe(false);
      expect(result.containerRunning).toBe(true);
      expect(result.errorClassification).toBeNull();
    });

    it('checks logs for fatal errors after 60 seconds', async () => {
      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'true', success: true }));
        }
        if (command.includes('/health')) {
          return Promise.resolve(createCommandResult({ success: false }));
        }
        if (command.includes('/v1/models')) {
          return Promise.resolve(createCommandResult({ success: false }));
        }
        if (command.includes('docker logs')) {
          return Promise.resolve(
            createCommandResult({
              stdout: 'Access to model meta-llama/Llama-3-70B is restricted and you are not in the authorized list',
              success: true,
            }),
          );
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new HealthCheckService(pool, 'error');

      // elapsedMs > 60s so logs will be checked
      const result = await service.poll(testSSHConfig, 'test-container', 'test-model', 70_000);

      expect(result.healthy).toBe(false);
      expect(result.errorClassification).not.toBeNull();
      expect(result.errorClassification!.category).toBe('gated_repo');
      expect(result.errorClassification!.isFatal).toBe(true);
    });
  });

  describe('waitForHealthy', () => {
    it('returns healthy result when endpoints pass on first poll', async () => {
      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'true', success: true }));
        }
        if (command.includes('/health') && !command.includes('/v1')) {
          return Promise.resolve(createCommandResult({ stdout: 'OK', success: true }));
        }
        if (command.includes('/v1/models')) {
          return Promise.resolve(
            createCommandResult({
              stdout: JSON.stringify({
                data: [{ id: 'meta-llama/Llama-3-70B', max_model_len: 128000 }],
              }),
              success: true,
            }),
          );
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new HealthCheckService(pool, 'error', {
        timeoutMs: 5_000,
        intervalMs: 100,
      });

      const result = await service.waitForHealthy(testSSHConfig, 'test-container', 'test-model');

      expect(result.healthy).toBe(true);
      expect(result.pollAttempts).toBe(1);
      expect(result.errorClassification).toBeNull();
      expect(result.modelInfo).not.toBeNull();
      expect(result.modelInfo!.id).toBe('meta-llama/Llama-3-70B');
      expect(result.modelInfo!.maxModelLen).toBe(128000);
    });

    it('throws HealthCheckServiceError on fatal error', async () => {
      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'false', success: true }));
        }
        if (command.includes('docker logs')) {
          return Promise.resolve(
            createCommandResult({
              stdout: 'CUDA out of memory. Tried to allocate 4.00 GiB',
              success: true,
            }),
          );
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new HealthCheckService(pool, 'error', {
        timeoutMs: 5_000,
        intervalMs: 100,
      });

      try {
        await service.waitForHealthy(testSSHConfig, 'test-container', 'test-model');
        // Should not reach here
        expect.unreachable('Expected HealthCheckServiceError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HealthCheckServiceError);
        const hcError = error as HealthCheckServiceError;
        expect(hcError.modelId).toBe('test-model');
        expect(hcError.classification.category).toBe('oom');
        expect(hcError.classification.isFatal).toBe(true);
        expect(hcError.result.healthy).toBe(false);
        expect(hcError.result.pollAttempts).toBe(1);
      }
    });

    it('throws HealthCheckServiceError on timeout', async () => {
      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'true', success: true }));
        }
        if (command.includes('/health')) {
          return Promise.resolve(createCommandResult({ success: false, stderr: 'Connection refused' }));
        }
        if (command.includes('/v1/models')) {
          return Promise.resolve(createCommandResult({ success: false }));
        }
        if (command.includes('docker logs')) {
          return Promise.resolve(
            createCommandResult({
              stdout: 'INFO: Loading model weights...\nINFO: Still loading...',
              success: true,
            }),
          );
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new HealthCheckService(pool, 'error', {
        timeoutMs: 200,
        intervalMs: 50,
      });

      try {
        await service.waitForHealthy(testSSHConfig, 'test-container', 'test-model');
        expect.unreachable('Expected HealthCheckServiceError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HealthCheckServiceError);
        const hcError = error as HealthCheckServiceError;
        expect(hcError.classification.category).toBe('timeout');
        expect(hcError.result.healthy).toBe(false);
        expect(hcError.result.pollAttempts).toBeGreaterThan(0);
      }
    });

    it('retries until health check passes', async () => {
      let healthCallCount = 0;

      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'true', success: true }));
        }
        if (command.includes('/health') && !command.includes('/v1')) {
          healthCallCount++;
          // Fail first 2 times, pass on 3rd
          if (healthCallCount < 3) {
            return Promise.resolve(
              createCommandResult({ success: false, stderr: 'Connection refused' }),
            );
          }
          return Promise.resolve(createCommandResult({ stdout: 'OK', success: true }));
        }
        if (command.includes('/v1/models')) {
          if (healthCallCount < 3) {
            return Promise.resolve(createCommandResult({ success: false }));
          }
          return Promise.resolve(
            createCommandResult({
              stdout: JSON.stringify({
                data: [{ id: 'test-model', max_model_len: 65536 }],
              }),
              success: true,
            }),
          );
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new HealthCheckService(pool, 'error', {
        timeoutMs: 10_000,
        intervalMs: 50,
      });

      const result = await service.waitForHealthy(testSSHConfig, 'test-container', 'test-model');

      expect(result.healthy).toBe(true);
      expect(result.pollAttempts).toBe(3);
      expect(result.modelInfo?.maxModelLen).toBe(65536);
    });

    it('classifies logs on timeout when fatal error present', async () => {
      let callCount = 0;

      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'true', success: true }));
        }
        if (command.includes('/health')) {
          return Promise.resolve(createCommandResult({ success: false }));
        }
        if (command.includes('/v1/models')) {
          return Promise.resolve(createCommandResult({ success: false }));
        }
        if (command.includes('docker logs')) {
          return Promise.resolve(
            createCommandResult({
              stdout: 'No space left on device',
              success: true,
            }),
          );
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new HealthCheckService(pool, 'error', {
        timeoutMs: 200,
        intervalMs: 50,
      });

      try {
        await service.waitForHealthy(testSSHConfig, 'test-container', 'test-model');
        expect.unreachable('Expected HealthCheckServiceError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HealthCheckServiceError);
        const hcError = error as HealthCheckServiceError;
        // Should classify as disk_space instead of generic timeout
        expect(hcError.classification.category).toBe('disk_space');
      }
    });
  });

  describe('formatResultSummary', () => {
    beforeEach(() => {
      const pool = createMockSSHPool();
      service = new HealthCheckService(pool, 'error');
    });

    it('formats a healthy result', () => {
      const result: HealthCheckResult = {
        healthy: true,
        totalTimeMs: 5000,
        pollAttempts: 3,
        errorClassification: null,
        containerLogs: null,
        modelInfo: {
          id: 'meta-llama/Llama-3-70B',
          maxModelLen: 128000,
          raw: {},
        },
      };

      const summary = service.formatResultSummary(result);

      expect(summary).toContain('passed');
      expect(summary).toContain('5000ms');
      expect(summary).toContain('3 attempts');
      expect(summary).toContain('meta-llama/Llama-3-70B');
      expect(summary).toContain('128000');
    });

    it('formats a failed result with classification', () => {
      const result: HealthCheckResult = {
        healthy: false,
        totalTimeMs: 600000,
        pollAttempts: 60,
        errorClassification: {
          category: 'oom',
          message: 'CUDA out of memory',
          isFatal: true,
          recommendation: 'Try reducing GPU memory utilization',
          matchedLogLines: ['CUDA out of memory. Tried to allocate 4.00 GiB'],
        },
        containerLogs: 'CUDA out of memory',
        modelInfo: null,
      };

      const summary = service.formatResultSummary(result);

      expect(summary).toContain('failed');
      expect(summary).toContain('oom');
      expect(summary).toContain('CUDA out of memory');
      expect(summary).toContain('Fatal: true');
      expect(summary).toContain('Try reducing');
    });

    it('formats a failed result without classification', () => {
      const result: HealthCheckResult = {
        healthy: false,
        totalTimeMs: 10000,
        pollAttempts: 5,
        errorClassification: null,
        containerLogs: null,
        modelInfo: null,
      };

      const summary = service.formatResultSummary(result);

      expect(summary).toContain('failed');
      expect(summary).toContain('unknown error');
    });
  });

  describe('error classes', () => {
    it('HealthCheckServiceError has correct properties', () => {
      const classification: HealthCheckErrorClassification = {
        category: 'oom',
        message: 'Out of memory',
        isFatal: true,
        recommendation: 'Reduce memory usage',
        matchedLogLines: ['CUDA OOM'],
      };

      const result: HealthCheckResult = {
        healthy: false,
        totalTimeMs: 5000,
        pollAttempts: 1,
        errorClassification: classification,
        containerLogs: 'CUDA OOM',
        modelInfo: null,
      };

      const error = new HealthCheckServiceError(
        'Health check failed',
        'model-123',
        classification,
        result,
      );

      expect(error.name).toBe('HealthCheckServiceError');
      expect(error.message).toBe('Health check failed');
      expect(error.modelId).toBe('model-123');
      expect(error.classification).toBe(classification);
      expect(error.classification.category).toBe('oom');
      expect(error.result).toBe(result);
      expect(error.result.healthy).toBe(false);
    });
  });
});
