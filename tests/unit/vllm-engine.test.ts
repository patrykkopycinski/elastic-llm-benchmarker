import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SSHConfig, VMHardwareProfile, BenchmarkThresholds } from '../../src/types/config.js';
import type { ModelInfo } from '../../src/types/benchmark.js';
import type { SSHClientPool, CommandResult } from '../../src/services/ssh-client.js';
import { VllmEngine } from '../../src/engines/vllm-engine.js';

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

const testModel: ModelInfo = {
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

const unsupportedModel: ModelInfo = {
  id: 'unknown/model',
  name: 'Unknown Model',
  architecture: 'custom_arch',
  contextWindow: 4096,
  license: 'apache-2.0',
  parameterCount: 1_000_000_000,
  quantizations: ['fp16'],
  supportsToolCalling: false,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('VllmEngine', () => {
  describe('constructor', () => {
    it('initializes with default options', () => {
      const pool = createMockSSHPool();
      const engine = new VllmEngine(pool, 'error');

      expect(engine).toBeInstanceOf(VllmEngine);
      expect(engine.engineType).toBe('vllm');
      expect(engine.getApiPort()).toBe(8000);
    });

    it('accepts custom API port', () => {
      const pool = createMockSSHPool();
      const engine = new VllmEngine(pool, 'error', {
        deployment: { apiPort: 9000 },
      });

      expect(engine.getApiPort()).toBe(9000);
    });
  });

  describe('resolveToolCallParser', () => {
    it('returns "hermes" for Qwen models', () => {
      const pool = createMockSSHPool();
      const engine = new VllmEngine(pool, 'error');

      expect(engine.resolveToolCallParser(testModel)).toBe('hermes');
    });

    it('returns "llama3_json" for Llama models', () => {
      const pool = createMockSSHPool();
      const engine = new VllmEngine(pool, 'error');

      expect(engine.resolveToolCallParser(llamaModel)).toBe('llama3_json');
    });

    it('returns null for unsupported architectures', () => {
      const pool = createMockSSHPool();
      const engine = new VllmEngine(pool, 'error');

      expect(engine.resolveToolCallParser(unsupportedModel)).toBeNull();
    });
  });

  describe('supportsToolCalling', () => {
    it('returns true for Qwen models', () => {
      const pool = createMockSSHPool();
      const engine = new VllmEngine(pool, 'error');

      expect(engine.supportsToolCalling(testModel)).toBe(true);
    });

    it('returns false for unsupported architectures', () => {
      const pool = createMockSSHPool();
      const engine = new VllmEngine(pool, 'error');

      expect(engine.supportsToolCalling(unsupportedModel)).toBe(false);
    });
  });

  describe('engineType', () => {
    it('is always "vllm"', () => {
      const pool = createMockSSHPool();
      const engine = new VllmEngine(pool, 'error');

      expect(engine.engineType).toBe('vllm');
    });
  });

  describe('getDeploymentService', () => {
    it('returns the underlying VllmDeploymentService', () => {
      const pool = createMockSSHPool();
      const engine = new VllmEngine(pool, 'error');

      const deploymentService = engine.getDeploymentService();
      expect(deploymentService).toBeDefined();
      expect(typeof deploymentService.deploy).toBe('function');
    });
  });

  describe('getBenchmarkRunner', () => {
    it('returns the underlying BenchmarkRunnerService', () => {
      const pool = createMockSSHPool();
      const engine = new VllmEngine(pool, 'error');

      const runner = engine.getBenchmarkRunner();
      expect(runner).toBeDefined();
      expect(typeof runner.runBenchmarks).toBe('function');
    });
  });
});
