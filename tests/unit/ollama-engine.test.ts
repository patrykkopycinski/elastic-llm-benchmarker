import { describe, it, expect, vi } from 'vitest';
import type { ModelInfo } from '../../src/types/benchmark.js';
import type { SSHClientPool } from '../../src/services/ssh-client.js';
import { OllamaEngine } from '../../src/engines/ollama-engine.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createMockSSHPool(): SSHClientPool {
  return {
    exec: vi.fn(),
    close: vi.fn(),
  } as unknown as SSHClientPool;
}

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

describe('OllamaEngine', () => {
  describe('constructor', () => {
    it('initializes with default options', () => {
      const pool = createMockSSHPool();
      const engine = new OllamaEngine(pool, 'error');

      expect(engine).toBeInstanceOf(OllamaEngine);
      expect(engine.engineType).toBe('ollama');
      expect(engine.getApiPort()).toBe(11434);
    });

    it('accepts custom API port', () => {
      const pool = createMockSSHPool();
      const engine = new OllamaEngine(pool, 'error', {
        deployment: { apiPort: 12345 },
      });

      expect(engine.getApiPort()).toBe(12345);
    });
  });

  describe('resolveToolCallParser', () => {
    it('returns "native" for Qwen models', () => {
      const pool = createMockSSHPool();
      const engine = new OllamaEngine(pool, 'error');

      expect(engine.resolveToolCallParser(qwenModel)).toBe('native');
    });

    it('returns null for Llama models (limited tool calling in Ollama)', () => {
      const pool = createMockSSHPool();
      const engine = new OllamaEngine(pool, 'error');

      // Llama models don't have reliable tool calling in Ollama
      expect(engine.resolveToolCallParser(llamaModel)).toBeNull();
    });

    it('returns null for unsupported architectures', () => {
      const pool = createMockSSHPool();
      const engine = new OllamaEngine(pool, 'error');

      expect(engine.resolveToolCallParser(unsupportedModel)).toBeNull();
    });
  });

  describe('supportsToolCalling', () => {
    it('returns true for Qwen models', () => {
      const pool = createMockSSHPool();
      const engine = new OllamaEngine(pool, 'error');

      expect(engine.supportsToolCalling(qwenModel)).toBe(true);
    });

    it('returns false for Llama models in Ollama', () => {
      const pool = createMockSSHPool();
      const engine = new OllamaEngine(pool, 'error');

      expect(engine.supportsToolCalling(llamaModel)).toBe(false);
    });

    it('returns false for unsupported architectures', () => {
      const pool = createMockSSHPool();
      const engine = new OllamaEngine(pool, 'error');

      expect(engine.supportsToolCalling(unsupportedModel)).toBe(false);
    });
  });

  describe('engineType', () => {
    it('is always "ollama"', () => {
      const pool = createMockSSHPool();
      const engine = new OllamaEngine(pool, 'error');

      expect(engine.engineType).toBe('ollama');
    });
  });

  describe('getDeploymentService', () => {
    it('returns the underlying OllamaDeploymentService', () => {
      const pool = createMockSSHPool();
      const engine = new OllamaEngine(pool, 'error');

      const deploymentService = engine.getDeploymentService();
      expect(deploymentService).toBeDefined();
      expect(typeof deploymentService.deploy).toBe('function');
    });
  });

  describe('getBenchmarkRunner', () => {
    it('returns the underlying OllamaBenchmarkRunnerService', () => {
      const pool = createMockSSHPool();
      const engine = new OllamaEngine(pool, 'error');

      const runner = engine.getBenchmarkRunner();
      expect(runner).toBeDefined();
      expect(typeof runner.runBenchmarks).toBe('function');
    });
  });
});
