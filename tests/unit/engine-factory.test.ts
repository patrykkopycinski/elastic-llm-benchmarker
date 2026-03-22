import { describe, it, expect, vi } from 'vitest';
import type { SSHClientPool } from '../../src/services/ssh-client.js';
import { EngineFactory, UnsupportedEngineError, createEngine } from '../../src/engines/engine-factory.js';
import { VllmEngine } from '../../src/engines/vllm-engine.js';
import { OllamaEngine } from '../../src/engines/ollama-engine.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createMockSSHPool(): SSHClientPool {
  return {
    exec: vi.fn(),
    close: vi.fn(),
  } as unknown as SSHClientPool;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EngineFactory', () => {
  describe('create', () => {
    it('creates a VllmEngine for "vllm" type', () => {
      const factory = new EngineFactory('error');
      const pool = createMockSSHPool();

      const engine = factory.create('vllm', pool, 'error');

      expect(engine).toBeInstanceOf(VllmEngine);
      expect(engine.engineType).toBe('vllm');
    });

    it('creates an OllamaEngine for "ollama" type', () => {
      const factory = new EngineFactory('error');
      const pool = createMockSSHPool();

      const engine = factory.create('ollama', pool, 'error');

      expect(engine).toBeInstanceOf(OllamaEngine);
      expect(engine.engineType).toBe('ollama');
    });

    it('throws UnsupportedEngineError for unknown engine types', () => {
      const factory = new EngineFactory('error');
      const pool = createMockSSHPool();

      expect(() =>
        factory.create('unknown' as never, pool, 'error'),
      ).toThrow(UnsupportedEngineError);
    });

    it('passes VllmEngineOptions through to VllmEngine', () => {
      const factory = new EngineFactory('error');
      const pool = createMockSSHPool();

      const engine = factory.create('vllm', pool, 'error', {
        deployment: { apiPort: 9000 },
      });

      expect(engine).toBeInstanceOf(VllmEngine);
      expect(engine.getApiPort()).toBe(9000);
    });

    it('passes OllamaEngineOptions through to OllamaEngine', () => {
      const factory = new EngineFactory('error');
      const pool = createMockSSHPool();

      const engine = factory.create('ollama', pool, 'error', {
        deployment: { apiPort: 12345 },
      });

      expect(engine).toBeInstanceOf(OllamaEngine);
      expect(engine.getApiPort()).toBe(12345);
    });
  });

  describe('createFromOptions', () => {
    it('creates an engine from factory options', () => {
      const factory = new EngineFactory('error');
      const pool = createMockSSHPool();

      const engine = factory.createFromOptions({
        engineType: 'vllm',
        sshPool: pool,
        logLevel: 'error',
      });

      expect(engine).toBeInstanceOf(VllmEngine);
      expect(engine.engineType).toBe('vllm');
    });
  });

  describe('isSupported', () => {
    it('returns true for "vllm"', () => {
      const factory = new EngineFactory('error');
      expect(factory.isSupported('vllm')).toBe(true);
    });

    it('returns true for "ollama"', () => {
      const factory = new EngineFactory('error');
      expect(factory.isSupported('ollama')).toBe(true);
    });

    it('returns false for unsupported engines', () => {
      const factory = new EngineFactory('error');
      expect(factory.isSupported('tgi')).toBe(false);
      expect(factory.isSupported('unknown')).toBe(false);
    });
  });

  describe('getSupportedEngines', () => {
    it('returns both vllm and ollama', () => {
      const factory = new EngineFactory('error');
      const supported = factory.getSupportedEngines();

      expect(supported).toContain('vllm');
      expect(supported).toContain('ollama');
      expect(supported).toHaveLength(2);
    });
  });

  describe('getDefaultEngineType', () => {
    it('returns "vllm" as default', () => {
      const factory = new EngineFactory('error');
      expect(factory.getDefaultEngineType()).toBe('vllm');
    });
  });

  describe('SUPPORTED_ENGINES static', () => {
    it('contains vllm and ollama', () => {
      expect(EngineFactory.SUPPORTED_ENGINES).toContain('vllm');
      expect(EngineFactory.SUPPORTED_ENGINES).toContain('ollama');
    });
  });
});

describe('createEngine convenience function', () => {
  it('creates a VllmEngine', () => {
    const pool = createMockSSHPool();
    const engine = createEngine('vllm', pool, 'error');

    expect(engine).toBeInstanceOf(VllmEngine);
    expect(engine.engineType).toBe('vllm');
  });

  it('creates an OllamaEngine', () => {
    const pool = createMockSSHPool();
    const engine = createEngine('ollama', pool, 'error');

    expect(engine).toBeInstanceOf(OllamaEngine);
    expect(engine.engineType).toBe('ollama');
  });
});

describe('UnsupportedEngineError', () => {
  it('has correct error properties', () => {
    const error = new UnsupportedEngineError('tgi', ['vllm', 'ollama']);

    expect(error.name).toBe('UnsupportedEngineError');
    expect(error.engineType).toBe('tgi');
    expect(error.supportedEngines).toEqual(['vllm', 'ollama']);
    expect(error.message).toContain('tgi');
    expect(error.message).toContain('vllm');
    expect(error.message).toContain('ollama');
  });
});
