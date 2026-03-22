import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ErrorRecoveryService } from '../../src/services/error-recovery.js';
import type {
  ErrorCategory,
  RecoveryAction,
  ErrorRecoveryDecision,
  RecoveryContext,
} from '../../src/services/error-recovery.js';
import {
  SSHConnectionError,
  SSHTimeoutError,
  SSHError,
} from '../../src/services/ssh-client.js';
import type { SSHClientPool, CommandResult } from '../../src/services/ssh-client.js';
import {
  VllmDeploymentError,
  ContainerError,
  HealthCheckError,
} from '../../src/services/vllm-deployment.js';
import type { VllmDeploymentService } from '../../src/services/vllm-deployment.js';
import { HealthCheckServiceError } from '../../src/services/health-check.js';
import type {
  HealthCheckErrorClassification,
  HealthCheckResult,
} from '../../src/services/health-check.js';
import { CircuitBreaker } from '../../src/services/circuit-breaker.js';
import type { SSHConfig } from '../../src/types/config.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

function createMockSSHPool(): SSHClientPool {
  return {
    exec: vi.fn().mockResolvedValue({
      command: 'mock',
      stdout: '',
      stderr: '',
      exitCode: 0,
      signal: null,
      success: true,
      durationMs: 100,
    } satisfies CommandResult),
    upload: vi.fn(),
    download: vi.fn(),
    uploadContent: vi.fn(),
    downloadContent: vi.fn(),
    getStatus: vi.fn().mockReturnValue([]),
    isConnected: vi.fn().mockReturnValue(true),
    disconnect: vi.fn(),
    close: vi.fn(),
  } as unknown as SSHClientPool;
}

function createMockDeployer(): VllmDeploymentService {
  return {
    deploy: vi.fn(),
    stop: vi.fn(),
    listContainers: vi.fn().mockResolvedValue([]),
    getContainerLogs: vi.fn(),
    resolveToolCallParser: vi.fn(),
    buildDockerRunCommand: vi.fn(),
    getHealthCheckService: vi.fn(),
  } as unknown as VllmDeploymentService;
}

function createMockSSHConfig(): SSHConfig {
  return {
    host: '10.0.0.1',
    port: 22,
    username: 'testuser',
    password: 'testpass',
  };
}

function createHealthCheckResult(healthy: boolean): HealthCheckResult {
  return {
    healthy,
    totalTimeMs: 5000,
    pollAttempts: 10,
    errorClassification: healthy ? null : {
      category: 'unknown',
      message: 'test error',
      isFatal: false,
      recommendation: 'test',
      matchedLogLines: [],
    },
    containerLogs: null,
    modelInfo: null,
  };
}

function createHealthCheckServiceError(
  category: string,
  modelId: string = 'test-model',
): HealthCheckServiceError {
  const classification: HealthCheckErrorClassification = {
    category: category as any,
    message: `${category} error occurred`,
    isFatal: true,
    recommendation: `Handle ${category}`,
    matchedLogLines: [],
  };

  const result = createHealthCheckResult(false);
  result.errorClassification = classification;

  return new HealthCheckServiceError(
    `Health check failed: ${category}`,
    modelId,
    classification,
    result,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ErrorRecoveryService', () => {
  let sshPool: SSHClientPool;
  let deployer: VllmDeploymentService;
  let circuitBreaker: CircuitBreaker;
  let recovery: ErrorRecoveryService;

  beforeEach(() => {
    vi.clearAllMocks();
    sshPool = createMockSSHPool();
    deployer = createMockDeployer();
    circuitBreaker = new CircuitBreaker({}, 'error');
    recovery = new ErrorRecoveryService(sshPool, deployer, circuitBreaker, 'error');
  });

  describe('constructor', () => {
    it('should create with default options', () => {
      const service = new ErrorRecoveryService(sshPool, deployer, circuitBreaker, 'error');
      expect(service).toBeInstanceOf(ErrorRecoveryService);
    });

    it('should create with custom options', () => {
      const service = new ErrorRecoveryService(sshPool, deployer, circuitBreaker, 'error', {
        maxSshRetries: 5,
        sshRetryBaseDelayMs: 10_000,
        maxDockerRetries: 3,
        dockerRetryBaseDelayMs: 20_000,
        benchmarkTerminationTimeoutMs: 60_000,
        maxTransientRetries: 4,
        transientRetryBaseDelayMs: 5_000,
      });
      expect(service).toBeInstanceOf(ErrorRecoveryService);
    });
  });

  describe('classifyError', () => {
    it('should classify SSHConnectionError as ssh_connection', () => {
      const error = new SSHConnectionError('10.0.0.1', 3, 3, new Error('Connection refused'));
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('ssh_connection');
      expect(decision.action).toBe('retry_with_backoff');
      expect(decision.shouldRecordInCircuitBreaker).toBe(false);
      expect(decision.isModelSpecific).toBe(false);
      expect(decision.maxRetries).toBeGreaterThan(0);
    });

    it('should classify SSHTimeoutError as ssh_timeout', () => {
      const error = new SSHTimeoutError('10.0.0.1', 'docker ps', 30000);
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('ssh_timeout');
      expect(decision.action).toBe('graceful_terminate');
      expect(decision.shouldRecordInCircuitBreaker).toBe(false);
    });

    it('should classify ContainerError as docker_crash', () => {
      const error = new ContainerError('model-a', 'run', 'vllm-model-a', new Error('failed'));
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('docker_crash');
      expect(decision.action).toBe('cleanup_and_retry');
      expect(decision.shouldRecordInCircuitBreaker).toBe(true);
    });

    it('should classify HealthCheckError as benchmark_timeout', () => {
      const error = new HealthCheckError('model-a', 600000, 'timeout');
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('benchmark_timeout');
      expect(decision.action).toBe('graceful_terminate');
      expect(decision.isModelSpecific).toBe(true);
    });

    it('should classify HealthCheckServiceError with OOM category as oom', () => {
      const error = createHealthCheckServiceError('oom');
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('oom');
      expect(decision.action).toBe('skip_model');
      expect(decision.shouldRecordInCircuitBreaker).toBe(true);
      expect(decision.maxRetries).toBe(0);
      expect(decision.isModelSpecific).toBe(true);
    });

    it('should classify HealthCheckServiceError with cuda_error as fatal_model_error', () => {
      const error = createHealthCheckServiceError('cuda_error');
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('fatal_model_error');
      expect(decision.action).toBe('skip_model');
    });

    it('should classify HealthCheckServiceError with gated_repo as fatal_model_error', () => {
      const error = createHealthCheckServiceError('gated_repo');
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('fatal_model_error');
      expect(decision.action).toBe('skip_model');
    });

    it('should classify HealthCheckServiceError with architecture_not_supported as fatal_model_error', () => {
      const error = createHealthCheckServiceError('architecture_not_supported');
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('fatal_model_error');
      expect(decision.action).toBe('skip_model');
    });

    it('should classify HealthCheckServiceError with container_crash as docker_crash', () => {
      const error = createHealthCheckServiceError('container_crash');
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('docker_crash');
      expect(decision.action).toBe('cleanup_and_retry');
    });

    it('should classify HealthCheckServiceError with network_error as transient', () => {
      const error = createHealthCheckServiceError('network_error');
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('transient');
      expect(decision.action).toBe('retry_with_backoff');
      expect(decision.shouldRecordInCircuitBreaker).toBe(false);
    });

    it('should classify HealthCheckServiceError with timeout as transient', () => {
      const error = createHealthCheckServiceError('timeout');
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('transient');
      expect(decision.action).toBe('retry_with_backoff');
    });

    it('should classify generic VllmDeploymentError as docker_crash', () => {
      const error = new VllmDeploymentError('deployment failed', 'model-a', new Error('test'));
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('docker_crash');
      expect(decision.action).toBe('cleanup_and_retry');
    });

    it('should classify generic SSHError as ssh_connection', () => {
      const error = new SSHError('something failed', '10.0.0.1', new Error('test'));
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('ssh_connection');
      expect(decision.action).toBe('retry_with_backoff');
    });

    it('should classify timeout-message errors as benchmark_timeout', () => {
      const error = new Error('Operation timed out after 600s');
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('benchmark_timeout');
      expect(decision.action).toBe('graceful_terminate');
    });

    it('should classify OOM-message errors as oom', () => {
      const error = new Error('CUDA out of memory');
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('oom');
      expect(decision.action).toBe('skip_model');
    });

    it('should classify unknown errors as unknown with retry', () => {
      const error = new Error('something unexpected');
      const decision = recovery.classifyError(error);

      expect(decision.category).toBe('unknown');
      expect(decision.action).toBe('retry_with_backoff');
    });

    it('should classify non-Error values as unknown', () => {
      const decision = recovery.classifyError('string error');

      expect(decision.category).toBe('unknown');
      expect(decision.action).toBe('retry_with_backoff');
    });
  });

  describe('execute', () => {
    const sshConfig = createMockSSHConfig();

    describe('retry_with_backoff', () => {
      it('should allow retry when under max retries', async () => {
        const context: RecoveryContext = {
          modelId: 'model-a',
          category: 'ssh_connection',
          attemptNumber: 1,
          error: new SSHConnectionError('10.0.0.1', 1, 3),
          action: 'retry_with_backoff',
          timestamp: Date.now(),
        };

        const result = await recovery.execute(sshConfig, context);

        expect(result.shouldRetry).toBe(true);
        expect(result.actionTaken).toBe('retry_with_backoff');
        expect(result.retryDelayMs).toBeGreaterThan(0);
        expect(result.context.attemptNumber).toBe(2);
      });

      it('should not allow retry when max retries exhausted', async () => {
        const context: RecoveryContext = {
          modelId: 'model-a',
          category: 'ssh_connection',
          attemptNumber: 3, // At max
          error: new SSHConnectionError('10.0.0.1', 3, 3),
          action: 'retry_with_backoff',
          timestamp: Date.now(),
        };

        const result = await recovery.execute(sshConfig, context);

        expect(result.shouldRetry).toBe(false);
        expect(result.message).toContain('Max retries exhausted');
      });
    });

    describe('cleanup_and_retry', () => {
      it('should clean up containers and allow retry', async () => {
        const context: RecoveryContext = {
          modelId: 'model-a',
          category: 'docker_crash',
          attemptNumber: 1,
          error: new ContainerError('model-a', 'run', 'vllm-model-a'),
          action: 'cleanup_and_retry',
          timestamp: Date.now(),
        };

        const result = await recovery.execute(sshConfig, context);

        expect(result.shouldRetry).toBe(true);
        expect(result.actionTaken).toBe('cleanup_and_retry');
        expect(result.message).toContain('Containers cleaned up');

        // Should have called SSH exec for cleanup commands
        expect(sshPool.exec).toHaveBeenCalled();
      });

      it('should exhaust retries after max docker retries', async () => {
        const context: RecoveryContext = {
          modelId: 'model-a',
          category: 'docker_crash',
          attemptNumber: 2, // At max (default maxDockerRetries = 2)
          error: new ContainerError('model-a', 'run', 'vllm-model-a'),
          action: 'cleanup_and_retry',
          timestamp: Date.now(),
        };

        const result = await recovery.execute(sshConfig, context);

        expect(result.shouldRetry).toBe(false);
      });
    });

    describe('graceful_terminate', () => {
      it('should terminate and allow retry when possible', async () => {
        const context: RecoveryContext = {
          modelId: 'model-a',
          category: 'benchmark_timeout',
          attemptNumber: 1,
          error: new Error('benchmark timed out'),
          action: 'graceful_terminate',
          timestamp: Date.now(),
        };

        const result = await recovery.execute(sshConfig, context);

        expect(result.actionTaken).toBe('graceful_terminate');
        expect(sshPool.exec).toHaveBeenCalled();
      });
    });

    describe('skip_model', () => {
      it('should skip model and record in circuit breaker', async () => {
        const context: RecoveryContext = {
          modelId: 'model-a',
          category: 'oom',
          attemptNumber: 1,
          error: new Error('CUDA out of memory'),
          action: 'skip_model',
          timestamp: Date.now(),
        };

        const result = await recovery.execute(sshConfig, context);

        expect(result.shouldRetry).toBe(false);
        expect(result.actionTaken).toBe('skip_model');
        expect(result.message).toContain('model-a');

        // Circuit breaker should have recorded the failure
        const record = circuitBreaker.getRecord('model-a');
        expect(record).not.toBeNull();
        expect(record!.failureCount).toBeGreaterThan(0);
      });
    });

    describe('abort', () => {
      it('should not retry on abort', async () => {
        const context: RecoveryContext = {
          modelId: 'model-a',
          category: 'unknown',
          attemptNumber: 1,
          error: new Error('fatal error'),
          action: 'abort',
          timestamp: Date.now(),
        };

        const result = await recovery.execute(sshConfig, context);

        expect(result.shouldRetry).toBe(false);
        expect(result.actionTaken).toBe('abort');
      });
    });

    describe('circuit breaker integration', () => {
      it('should record failures in circuit breaker for model-specific errors', async () => {
        const context: RecoveryContext = {
          modelId: 'model-a',
          category: 'oom',
          attemptNumber: 1,
          error: new Error('CUDA out of memory'),
          action: 'skip_model',
          timestamp: Date.now(),
        };

        await recovery.execute(sshConfig, context);

        // The circuit breaker should have recorded a failure
        const record = circuitBreaker.getRecord('model-a');
        expect(record).not.toBeNull();
      });

      it('should not record SSH errors in circuit breaker', async () => {
        const error = new SSHConnectionError('10.0.0.1', 1, 3);
        const context: RecoveryContext = {
          modelId: 'model-a',
          category: 'ssh_connection',
          attemptNumber: 1,
          error,
          action: 'retry_with_backoff',
          timestamp: Date.now(),
        };

        await recovery.execute(sshConfig, context);

        // SSH errors are infrastructure, not model-specific
        const record = circuitBreaker.getRecord('model-a');
        expect(record).toBeNull();
      });
    });
  });

  describe('cleanupContainers', () => {
    const sshConfig = createMockSSHConfig();

    it('should execute cleanup commands', async () => {
      await recovery.cleanupContainers(sshConfig);

      // Should have called SSH for listing and cleaning up containers
      expect(sshPool.exec).toHaveBeenCalled();
    });

    it('should cleanup a specific container', async () => {
      await recovery.cleanupContainers(sshConfig, 'vllm-model-test');

      // Should have been called with docker stop and docker rm commands
      const calls = vi.mocked(sshPool.exec).mock.calls;
      const commands = calls.map((c) => c[1] as string);
      expect(commands.some((cmd) => cmd.includes('docker stop vllm-model-test'))).toBe(true);
      expect(commands.some((cmd) => cmd.includes('docker rm'))).toBe(true);
    });

    it('should not throw on cleanup errors', async () => {
      vi.mocked(sshPool.exec).mockRejectedValueOnce(new Error('SSH failed'));

      // Should not throw
      await expect(recovery.cleanupContainers(sshConfig)).resolves.not.toThrow();
    });
  });

  describe('gracefullyTerminateBenchmark', () => {
    const sshConfig = createMockSSHConfig();

    it('should stop and remove the container', async () => {
      await recovery.gracefullyTerminateBenchmark(sshConfig, 'vllm-model-test');

      const calls = vi.mocked(sshPool.exec).mock.calls;
      const commands = calls.map((c) => c[1] as string);
      expect(commands.some((cmd) => cmd.includes('docker stop'))).toBe(true);
    });

    it('should force-kill when graceful stop fails', async () => {
      vi.mocked(sshPool.exec)
        .mockResolvedValueOnce({
          command: 'docker stop --time=15 vllm-model-test',
          stdout: '',
          stderr: 'error',
          exitCode: 1,
          signal: null,
          success: false,
          durationMs: 100,
        })
        .mockResolvedValue({
          command: 'docker kill vllm-model-test',
          stdout: '',
          stderr: '',
          exitCode: 0,
          signal: null,
          success: true,
          durationMs: 100,
        });

      await recovery.gracefullyTerminateBenchmark(sshConfig, 'vllm-model-test');

      const calls = vi.mocked(sshPool.exec).mock.calls;
      const commands = calls.map((c) => c[1] as string);
      expect(commands.some((cmd) => cmd.includes('docker kill'))).toBe(true);
    });

    it('should not throw on termination errors', async () => {
      vi.mocked(sshPool.exec).mockRejectedValue(new Error('SSH failed'));

      await expect(
        recovery.gracefullyTerminateBenchmark(sshConfig, 'vllm-model-test'),
      ).resolves.not.toThrow();
    });
  });

  describe('createContext', () => {
    it('should create a recovery context from an error', () => {
      const error = new SSHConnectionError('10.0.0.1', 1, 3);
      const context = recovery.createContext('model-a', error, 1);

      expect(context.modelId).toBe('model-a');
      expect(context.category).toBe('ssh_connection');
      expect(context.attemptNumber).toBe(1);
      expect(context.error).toBe(error);
      expect(context.action).toBe('retry_with_backoff');
      expect(context.timestamp).toBeTypeOf('number');
    });

    it('should default attempt number to 1', () => {
      const error = new Error('test');
      const context = recovery.createContext('model-a', error);

      expect(context.attemptNumber).toBe(1);
    });
  });
});
