import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ModelInfo } from '../../src/types/benchmark.js';
import type { SSHConfig, VMHardwareProfile } from '../../src/types/config.js';
import type { CommandResult, SSHClientPool } from '../../src/services/ssh-client.js';
import {
  VllmDeploymentService,
  VllmDeploymentError,
  ContainerError,
  HealthCheckError,
} from '../../src/services/vllm-deployment.js';
import { HealthCheckServiceError } from '../../src/services/health-check.js';

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

const testHardwareProfile: VMHardwareProfile = {
  gpuType: 'nvidia-a100-80gb',
  gpuCount: 2,
  ramGb: 680,
  cpuCores: 24,
  diskGb: 1000,
  machineType: 'a2-ultragpu-2g',
};

function createTestModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'meta-llama/Llama-3-70B-Instruct',
    name: 'Llama 3 70B Instruct',
    architecture: 'llama',
    contextWindow: 128_000,
    license: 'llama3',
    parameterCount: 70_000_000_000,
    quantizations: ['fp16', 'gptq'],
    supportsToolCalling: true,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('VllmDeploymentService', () => {
  let service: VllmDeploymentService;
  let mockExec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec = vi.fn();
  });

  describe('constructor', () => {
    it('initializes with default options', () => {
      const pool = createMockSSHPool();
      service = new VllmDeploymentService(pool, 'error');
      expect(service).toBeInstanceOf(VllmDeploymentService);
    });

    it('accepts custom options', () => {
      const pool = createMockSSHPool();
      service = new VllmDeploymentService(pool, 'error', {
        dockerImage: 'custom/image:v1',
        apiPort: 9000,
        maxModelLen: 4096,
        gpuMemoryUtilization: 0.85,
      });
      expect(service).toBeInstanceOf(VllmDeploymentService);
    });
  });

  describe('resolveToolCallParser', () => {
    beforeEach(() => {
      const pool = createMockSSHPool();
      service = new VllmDeploymentService(pool, 'error');
    });

    it('returns hermes for qwen architecture', () => {
      const model = createTestModel({ id: 'Qwen/Qwen2.5-7B-Instruct', architecture: 'qwen' });
      expect(service.resolveToolCallParser(model)).toBe('hermes');
    });

    it('returns hermes for qwen2 architecture', () => {
      const model = createTestModel({ id: 'Qwen/Qwen2-7B-Instruct', architecture: 'qwen2' });
      expect(service.resolveToolCallParser(model)).toBe('hermes');
    });

    it('returns hermes for qwen2_moe architecture', () => {
      const model = createTestModel({ id: 'Qwen/Qwen2-MoE-57B', architecture: 'qwen2_moe' });
      expect(service.resolveToolCallParser(model)).toBe('hermes');
    });

    it('returns mistral for mistral architecture', () => {
      const model = createTestModel({ id: 'mistralai/Mistral-7B-Instruct-v0.3', architecture: 'mistral' });
      expect(service.resolveToolCallParser(model)).toBe('mistral');
    });

    it('returns mistral for mixtral architecture', () => {
      const model = createTestModel({ id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', architecture: 'mixtral' });
      expect(service.resolveToolCallParser(model)).toBe('mistral');
    });

    it('returns llama3_json for llama architecture', () => {
      const model = createTestModel({ id: 'meta-llama/Llama-3-8B-Instruct', architecture: 'llama' });
      expect(service.resolveToolCallParser(model)).toBe('llama3_json');
    });

    it('returns llama3_json for codellama architecture', () => {
      const model = createTestModel({ id: 'meta-llama/CodeLlama-13B', architecture: 'codellama' });
      expect(service.resolveToolCallParser(model)).toBe('llama3_json');
    });

    it('returns hermes for gemma (not null - gemma supports tool calling)', () => {
      const model = createTestModel({ id: 'google/gemma-2-9b-it', architecture: 'gemma' });
      expect(service.resolveToolCallParser(model)).toBe('hermes');
    });

    it('falls back to model ID hints for qwen', () => {
      const model = createTestModel({
        architecture: 'unknown',
        id: 'Qwen/Qwen2-72B-Instruct',
      });
      expect(service.resolveToolCallParser(model)).toBe('hermes');
    });

    it('falls back to model ID hints for mistral', () => {
      const model = createTestModel({
        architecture: 'unknown',
        id: 'mistralai/Mistral-7B-Instruct-v0.3',
      });
      expect(service.resolveToolCallParser(model)).toBe('mistral');
    });

    it('falls back to model ID hints for llama', () => {
      const model = createTestModel({
        architecture: 'unknown',
        id: 'meta-llama/Llama-3-8B-Instruct',
      });
      expect(service.resolveToolCallParser(model)).toBe('llama3_json');
    });
  });

  describe('buildDockerRunCommand', () => {
    it('builds a correct command with tool call parser', () => {
      const pool = createMockSSHPool();
      service = new VllmDeploymentService(pool, 'error');
      const model = createTestModel(); // Llama model has tool calling support

      const command = service.buildDockerRunCommand(
        model,
        'vllm-model-test',
        2,
      );

      expect(command).toContain('docker run -d');
      expect(command).toContain('--name vllm-model-test');
      expect(command).toContain('--gpus all');
      expect(command).toContain('--shm-size=16g');
      expect(command).toContain('-p 8000:8000');
      expect(command).toContain('vllm/vllm-openai:v0.15.1');
      expect(command).toContain(`--model ${model.id}`);
      expect(command).toContain('--tensor-parallel-size 2');
      expect(command).toContain('--tool-call-parser llama3_json');
      expect(command).toContain('--gpu-memory-utilization 0.9');
      expect(command).toContain('--tool-call-parser llama3_json');
      expect(command).toContain('--enable-auto-tool-choice');
    });

    it('builds command without tool call parser when model does not support it', () => {
      const pool = createMockSSHPool();
      service = new VllmDeploymentService(pool, 'error');
      // Use a model with unsupported architecture (no tool calling)
      const model = createTestModel({
        id: 'EleutherAI/gpt-neo-2.7B',
        architecture: 'gpt_neo',
        supportsToolCalling: false,
      });

      const command = service.buildDockerRunCommand(model, 'vllm-model-test', 2);

      expect(command).not.toContain('--tool-call-parser');
      expect(command).not.toContain('--enable-auto-tool-choice');
    });

    it('includes max-model-len when configured', () => {
      const pool = createMockSSHPool();
      service = new VllmDeploymentService(pool, 'error', { maxModelLen: 4096 });
      const model = createTestModel();

      const command = service.buildDockerRunCommand(
        model,
        'vllm-model-test',
        2,
        'llama3_json',
      );

      expect(command).toContain('--max-model-len 4096');
    });

    it('uses custom docker image', () => {
      const pool = createMockSSHPool();
      service = new VllmDeploymentService(pool, 'error', {
        dockerImage: 'vllm/vllm-openai:v0.5.0',
      });
      const model = createTestModel();

      const command = service.buildDockerRunCommand(
        model,
        'vllm-model-test',
        2,
        'llama3_json',
      );

      expect(command).toContain('vllm/vllm-openai:v0.5.0');
    });

    it('uses custom api port', () => {
      const pool = createMockSSHPool();
      service = new VllmDeploymentService(pool, 'error', { apiPort: 9000 });
      const model = createTestModel();

      const command = service.buildDockerRunCommand(
        model,
        'vllm-model-test',
        2,
        'llama3_json',
      );

      expect(command).toContain('-p 9000:8000');
    });

    it('includes additional docker args', () => {
      const pool = createMockSSHPool();
      service = new VllmDeploymentService(pool, 'error', {
        additionalDockerArgs: ['--dtype float16', '--enforce-eager'],
      });
      const model = createTestModel();

      const command = service.buildDockerRunCommand(
        model,
        'vllm-model-test',
        2,
        'llama3_json',
      );

      expect(command).toContain('--dtype float16');
      expect(command).toContain('--enforce-eager');
    });

    it('uses tensor-parallel-size from gpu count', () => {
      const pool = createMockSSHPool();
      service = new VllmDeploymentService(pool, 'error');
      const model = createTestModel();

      const command = service.buildDockerRunCommand(
        model,
        'vllm-model-test',
        4,
        'llama3_json',
      );

      expect(command).toContain('--tensor-parallel-size 4');
    });
  });

  describe('listContainers', () => {
    it('returns empty array when no containers found', async () => {
      mockExec.mockResolvedValueOnce(createCommandResult({ stdout: '', success: true }));
      const pool = createMockSSHPool(mockExec);
      service = new VllmDeploymentService(pool, 'error');

      const containers = await service.listContainers(testSSHConfig);
      expect(containers).toEqual([]);
    });

    it('parses container output correctly', async () => {
      mockExec.mockResolvedValueOnce(
        createCommandResult({
          stdout:
            'abc123|vllm-model-test|running|vllm/vllm-openai:latest|Up 5 minutes\ndef456|vllm-model-old|exited|vllm/vllm-openai:latest|Exited (0) 1 hour ago',
          success: true,
        }),
      );
      const pool = createMockSSHPool(mockExec);
      service = new VllmDeploymentService(pool, 'error');

      const containers = await service.listContainers(testSSHConfig);
      expect(containers).toHaveLength(2);
      expect(containers[0]).toEqual({
        containerId: 'abc123',
        containerName: 'vllm-model-test',
        state: 'running',
        image: 'vllm/vllm-openai:latest',
        status: 'Up 5 minutes',
      });
      expect(containers[1]).toEqual({
        containerId: 'def456',
        containerName: 'vllm-model-old',
        state: 'exited',
        image: 'vllm/vllm-openai:latest',
        status: 'Exited (0) 1 hour ago',
      });
    });

    it('returns empty array on command failure', async () => {
      mockExec.mockResolvedValueOnce(
        createCommandResult({ success: false, stderr: 'permission denied' }),
      );
      const pool = createMockSSHPool(mockExec);
      service = new VllmDeploymentService(pool, 'error');

      const containers = await service.listContainers(testSSHConfig);
      expect(containers).toEqual([]);
    });
  });

  describe('stop', () => {
    it('stops and removes a container successfully', async () => {
      mockExec.mockResolvedValueOnce(createCommandResult({ success: true }));
      const pool = createMockSSHPool(mockExec);
      service = new VllmDeploymentService(pool, 'error');

      const result = await service.stop(testSSHConfig, 'vllm-model-test');
      expect(result).toBe(true);
      expect(mockExec).toHaveBeenCalledWith(
        testSSHConfig,
        'docker stop vllm-model-test && docker rm vllm-model-test',
        expect.any(Object),
      );
    });

    it('returns false if container not found', async () => {
      mockExec.mockResolvedValueOnce(
        createCommandResult({
          success: false,
          stderr: 'Error response from daemon: No such container: vllm-model-test',
        }),
      );
      const pool = createMockSSHPool(mockExec);
      service = new VllmDeploymentService(pool, 'error');

      const result = await service.stop(testSSHConfig, 'vllm-model-test');
      expect(result).toBe(false);
    });
  });

  describe('getContainerLogs', () => {
    it('returns container logs', async () => {
      const expectedLogs = 'INFO: vLLM server started\nINFO: Model loaded successfully';
      mockExec.mockResolvedValueOnce(
        createCommandResult({ stdout: expectedLogs, success: true }),
      );
      const pool = createMockSSHPool(mockExec);
      service = new VllmDeploymentService(pool, 'error');

      const logs = await service.getContainerLogs(testSSHConfig, 'vllm-model-test', 50);
      expect(logs).toBe(expectedLogs);
    });
  });

  describe('deploy', () => {
    it('executes the full deployment lifecycle', async () => {
      const model = createTestModel();
      let callCount = 0;

      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        callCount++;

        // Call 1: listContainers (for stopExistingContainers)
        if (command.includes('docker ps')) {
          return Promise.resolve(createCommandResult({ stdout: '', success: true }));
        }

        // Call 2: docker pull
        if (command.includes('docker pull')) {
          return Promise.resolve(
            createCommandResult({ stdout: 'Pull complete\n', success: true, durationMs: 5000 }),
          );
        }

        // Call 3: docker run
        if (command.includes('docker run')) {
          return Promise.resolve(
            createCommandResult({
              stdout: 'abc123def456\n',
              success: true,
            }),
          );
        }

        // Call 4: container running check (docker inspect)
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'true', success: true }));
        }

        // Call 5: health check (curl)
        if (command.includes('/health')) {
          return Promise.resolve(createCommandResult({ stdout: 'OK', success: true }));
        }

        // Call 6: detect max-model-len (/v1/models)
        if (command.includes('/v1/models')) {
          return Promise.resolve(
            createCommandResult({
              stdout: JSON.stringify({
                data: [{ id: model.id, max_model_len: 128000 }],
              }),
              success: true,
            }),
          );
        }

        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new VllmDeploymentService(pool, 'error');

      const result = await service.deploy(testSSHConfig, model, testHardwareProfile);

      expect(result.containerId).toBe('abc123def456');
      expect(result.modelId).toBe(model.id);
      expect(result.toolCallParser).toBe('llama3_json');
      expect(result.tensorParallelSize).toBe(2);
      expect(result.maxModelLen).toBe(128000);
      expect(result.apiEndpoint).toBe('http://10.0.0.1:8000');
      expect(result.dockerImage).toBe('vllm/vllm-openai:v0.15.1');
      expect(result.dockerCommand).toContain('docker run -d');
      expect(result.dockerCommand).toContain('--tensor-parallel-size 2');
      expect(result.dockerCommand).toContain('--tool-call-parser llama3_json');
      expect(result.dockerCommand).toContain('--enable-auto-tool-choice');
      expect(result.timestamp).toBeTruthy();
      expect(result.healthCheckResult).not.toBeNull();
      expect(result.healthCheckResult!.healthy).toBe(true);
    });

    it('stops existing containers before deploying', async () => {
      const model = createTestModel();
      const commands: string[] = [];

      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        commands.push(command);

        // listContainers returns an existing container
        if (command.includes('docker ps')) {
          return Promise.resolve(
            createCommandResult({
              stdout: 'abc123|vllm-model-old|running|vllm/vllm-openai:latest|Up 10 hours',
              success: true,
            }),
          );
        }

        // force remove existing container (rm -f)
        if (command.includes('docker rm -f') && command.includes('vllm-model-old')) {
          return Promise.resolve(createCommandResult({ success: true }));
        }

        // docker pull
        if (command.includes('docker pull')) {
          return Promise.resolve(createCommandResult({ success: true, durationMs: 1000 }));
        }

        // docker run
        if (command.includes('docker run')) {
          return Promise.resolve(
            createCommandResult({ stdout: 'newcontainer123\n', success: true }),
          );
        }

        // docker inspect
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'true', success: true }));
        }

        // health check
        if (command.includes('/health')) {
          return Promise.resolve(createCommandResult({ stdout: 'OK', success: true }));
        }

        // /v1/models
        if (command.includes('/v1/models')) {
          return Promise.resolve(
            createCommandResult({
              stdout: JSON.stringify({ data: [{ max_model_len: 128000 }] }),
              success: true,
            }),
          );
        }

        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new VllmDeploymentService(pool, 'error');

      await service.deploy(testSSHConfig, model, testHardwareProfile);

      // Verify force remove (rm -f) was called before pull
      const rmIdx = commands.findIndex(
        (c) => c.includes('docker rm -f') && c.includes('vllm-model-old'),
      );
      const pullIdx = commands.findIndex((c) => c.includes('docker pull'));
      expect(rmIdx).toBeGreaterThan(-1);
      expect(pullIdx).toBeGreaterThan(rmIdx);
    });

    it('throws ContainerError when docker pull fails', async () => {
      const model = createTestModel();

      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker ps')) {
          return Promise.resolve(createCommandResult({ stdout: '', success: true }));
        }
        if (command.includes('docker pull')) {
          return Promise.resolve(
            createCommandResult({
              success: false,
              stderr: 'Error: pull access denied',
            }),
          );
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new VllmDeploymentService(pool, 'error');

      await expect(
        service.deploy(testSSHConfig, model, testHardwareProfile),
      ).rejects.toThrow(ContainerError);
    });

    it('throws ContainerError when docker run fails', async () => {
      const model = createTestModel();

      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker ps')) {
          return Promise.resolve(createCommandResult({ stdout: '', success: true }));
        }
        if (command.includes('docker pull')) {
          return Promise.resolve(createCommandResult({ success: true, durationMs: 100 }));
        }
        if (command.includes('docker run')) {
          return Promise.resolve(
            createCommandResult({
              success: false,
              stderr: 'OCI runtime create failed: unable to start container',
            }),
          );
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new VllmDeploymentService(pool, 'error');

      await expect(
        service.deploy(testSSHConfig, model, testHardwareProfile),
      ).rejects.toThrow(ContainerError);
    });

    it('throws HealthCheckServiceError when container exits during health check', async () => {
      const model = createTestModel();

      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker ps')) {
          return Promise.resolve(createCommandResult({ stdout: '', success: true }));
        }
        if (command.includes('docker pull')) {
          return Promise.resolve(createCommandResult({ success: true, durationMs: 100 }));
        }
        if (command.includes('docker run')) {
          return Promise.resolve(
            createCommandResult({ stdout: 'container123\n', success: true }),
          );
        }
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'false', success: true }));
        }
        if (command.includes('docker logs')) {
          return Promise.resolve(
            createCommandResult({
              stdout: 'CUDA out of memory',
              success: true,
            }),
          );
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new VllmDeploymentService(pool, 'error');

      await expect(
        service.deploy(testSSHConfig, model, testHardwareProfile),
      ).rejects.toThrow(HealthCheckServiceError);
    });

    it('uses correct tensor-parallel-size from hardware profile', async () => {
      const model = createTestModel();
      const hwProfile: VMHardwareProfile = {
        ...testHardwareProfile,
        gpuCount: 4,
      };

      let capturedRunCommand = '';

      mockExec.mockImplementation((_config: SSHConfig, command: string) => {
        if (command.includes('docker ps')) {
          return Promise.resolve(createCommandResult({ stdout: '', success: true }));
        }
        if (command.includes('docker pull')) {
          return Promise.resolve(createCommandResult({ success: true, durationMs: 100 }));
        }
        if (command.includes('docker run')) {
          capturedRunCommand = command;
          return Promise.resolve(
            createCommandResult({ stdout: 'container123\n', success: true }),
          );
        }
        if (command.includes('docker inspect')) {
          return Promise.resolve(createCommandResult({ stdout: 'true', success: true }));
        }
        if (command.includes('/health')) {
          return Promise.resolve(createCommandResult({ stdout: 'OK', success: true }));
        }
        if (command.includes('/v1/models')) {
          return Promise.resolve(
            createCommandResult({
              stdout: JSON.stringify({ data: [] }),
              success: true,
            }),
          );
        }
        return Promise.resolve(createCommandResult({ success: true }));
      });

      const pool = createMockSSHPool(mockExec);
      service = new VllmDeploymentService(pool, 'error');

      const result = await service.deploy(testSSHConfig, model, hwProfile);

      expect(result.tensorParallelSize).toBe(4);
      expect(capturedRunCommand).toContain('--tensor-parallel-size 4');
    });
  });

  describe('error classes', () => {
    it('VllmDeploymentError has correct properties', () => {
      const cause = new Error('underlying error');
      const error = new VllmDeploymentError('deploy failed', 'model-123', cause);

      expect(error.name).toBe('VllmDeploymentError');
      expect(error.message).toBe('deploy failed');
      expect(error.modelId).toBe('model-123');
      expect(error.cause).toBe(cause);
    });

    it('ContainerError has correct properties', () => {
      const cause = new Error('docker error');
      const error = new ContainerError('model-123', 'pull', 'vllm-test', cause);

      expect(error.name).toBe('ContainerError');
      expect(error.modelId).toBe('model-123');
      expect(error.operation).toBe('pull');
      expect(error.containerName).toBe('vllm-test');
      expect(error.message).toContain('Docker pull failed');
      expect(error.message).toContain('vllm-test');
    });

    it('HealthCheckError has correct properties', () => {
      const error = new HealthCheckError('model-123', 60000, 'connection refused');

      expect(error.name).toBe('HealthCheckError');
      expect(error.modelId).toBe('model-123');
      expect(error.timeoutMs).toBe(60000);
      expect(error.lastError).toBe('connection refused');
      expect(error.message).toContain('timed out after 60000ms');
    });
  });
});
