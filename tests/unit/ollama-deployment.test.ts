import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SSHConfig, VMHardwareProfile } from '../../src/types/config.js';
import type { ModelInfo } from '../../src/types/benchmark.js';
import type { SSHClientPool, CommandResult } from '../../src/services/ssh-client.js';
import {
  OllamaDeploymentService,
  OllamaDeploymentError,
  OllamaModelPullError,
  OllamaServiceError,
} from '../../src/services/ollama-deployment.js';

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

const qwenModel: ModelInfo = {
  id: 'Qwen/Qwen2.5-7B-Instruct',
  name: 'Qwen2.5-7B-Instruct',
  architecture: 'qwen2',
  contextWindow: 131072,
  license: 'apache-2.0',
  parameterCount: 7_000_000_000,
  quantizations: ['fp16'],
  supportsToolCalling: true,
};

const llamaModel: ModelInfo = {
  id: 'meta-llama/Llama-3-70B-Instruct',
  name: 'Llama-3-70B-Instruct',
  architecture: 'llama',
  contextWindow: 131072,
  license: 'llama3',
  parameterCount: 70_000_000_000,
  quantizations: ['fp16'],
  supportsToolCalling: true,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OllamaDeploymentService', () => {
  let mockExec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec = vi.fn();
  });

  describe('constructor', () => {
    it('initializes with default options', () => {
      const pool = createMockSSHPool();
      const service = new OllamaDeploymentService(pool, 'error');
      expect(service).toBeInstanceOf(OllamaDeploymentService);
    });

    it('accepts custom options', () => {
      const pool = createMockSSHPool();
      const service = new OllamaDeploymentService(pool, 'error', {
        apiPort: 12345,
        useDocker: true,
        numGpuLayers: 32,
      });
      expect(service).toBeInstanceOf(OllamaDeploymentService);
    });
  });

  describe('resolveOllamaModelName', () => {
    it('resolves Qwen model names correctly', () => {
      const pool = createMockSSHPool();
      const service = new OllamaDeploymentService(pool, 'error');

      const result = service.resolveOllamaModelName(qwenModel);
      expect(result).toContain('qwen2.5');
      expect(result).toContain('7b');
    });

    it('resolves Llama model names correctly', () => {
      const pool = createMockSSHPool();
      const service = new OllamaDeploymentService(pool, 'error');

      const result = service.resolveOllamaModelName(llamaModel);
      expect(result).toContain('llama3');
      expect(result).toContain('70b');
    });

    it('falls back to model ID for unknown models', () => {
      const pool = createMockSSHPool();
      const service = new OllamaDeploymentService(pool, 'error');

      const unknownModel: ModelInfo = {
        id: 'custom/my-model',
        name: 'My Model',
        architecture: 'custom',
        contextWindow: 4096,
        license: 'apache-2.0',
        parameterCount: 1_000_000_000,
        quantizations: ['fp16'],
        supportsToolCalling: false,
      };

      const result = service.resolveOllamaModelName(unknownModel);
      expect(result).toBe('custom/my-model');
    });
  });

  describe('resolveToolCallMethod', () => {
    it('returns "native" for Qwen models', () => {
      const pool = createMockSSHPool();
      const service = new OllamaDeploymentService(pool, 'error');

      expect(service.resolveToolCallMethod(qwenModel)).toBe('native');
    });

    it('returns null for Llama models (limited Ollama tool calling)', () => {
      const pool = createMockSSHPool();
      const service = new OllamaDeploymentService(pool, 'error');

      expect(service.resolveToolCallMethod(llamaModel)).toBeNull();
    });
  });

  describe('buildLoadCommand', () => {
    it('builds a correct curl command for model loading', () => {
      const pool = createMockSSHPool();
      const service = new OllamaDeploymentService(pool, 'error');

      const command = service.buildLoadCommand('qwen2.5:7b');

      expect(command).toContain('curl');
      expect(command).toContain('http://localhost:11434/api/generate');
      expect(command).toContain('qwen2.5:7b');
      expect(command).toContain('keep_alive');
    });

    it('uses custom port when configured', () => {
      const pool = createMockSSHPool();
      const service = new OllamaDeploymentService(pool, 'error', {
        apiPort: 12345,
      });

      const command = service.buildLoadCommand('qwen2.5:7b');
      expect(command).toContain('http://localhost:12345');
    });
  });

  describe('error classes', () => {
    it('OllamaDeploymentError has correct properties', () => {
      const error = new OllamaDeploymentError('test error', 'model-123');
      expect(error.name).toBe('OllamaDeploymentError');
      expect(error.message).toBe('test error');
      expect(error.modelId).toBe('model-123');
    });

    it('OllamaModelPullError has correct properties', () => {
      const cause = new Error('network error');
      const error = new OllamaModelPullError('model-123', cause);
      expect(error.name).toBe('OllamaModelPullError');
      expect(error.message).toContain('model-123');
      expect(error.message).toContain('network error');
      expect(error.modelId).toBe('model-123');
      expect(error.cause).toBe(cause);
    });

    it('OllamaServiceError has correct properties', () => {
      const error = new OllamaServiceError('model-123', 'docker start');
      expect(error.name).toBe('OllamaServiceError');
      expect(error.message).toContain('model-123');
      expect(error.message).toContain('docker start');
    });
  });
});
