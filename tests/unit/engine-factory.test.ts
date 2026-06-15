import { describe, it, expect } from 'vitest';
import { EngineFactory, UnsupportedEngineError, createEngine } from '../../src/engines/engine-factory.js';
import { VllmEngine } from '../../src/engines/vllm-engine.js';
import type { SSHClientPool } from '../../src/services/ssh-client.js';

const mockSshPool = {} as unknown as SSHClientPool;

describe('EngineFactory', () => {
  it('creates VllmEngine with default options', () => {
    const factory = new EngineFactory('info');
    const engine = factory.create('vllm', mockSshPool, 'info');

    expect(engine).toBeInstanceOf(VllmEngine);
  });

  it('throws UnsupportedEngineError for unknown engine type', () => {
    const factory = new EngineFactory('info');
    expect(() =>
      // @ts-expect-error testing invalid engine type
      factory.create('unknown', mockSshPool, 'info')
    ).toThrow(UnsupportedEngineError);
  });

  it('throws UnsupportedEngineError for ollama (removed)', () => {
    const factory = new EngineFactory('info');
    expect(() =>
      // @ts-expect-error testing removed engine type
      factory.create('ollama', mockSshPool, 'info')
    ).toThrow(UnsupportedEngineError);
  });

  it('passes deployment options to VllmEngine', () => {
    const factory = new EngineFactory('debug');
    const engine = factory.create('vllm', mockSshPool, 'debug', {
      deployment: {
        apiPort: 8001,
        dockerImage: 'custom:v1',
        gpuMemoryUtilization: 0.95,
        maxModelLen: 4096,
        useSudo: true,
      },
    });

    expect(engine).toBeInstanceOf(VllmEngine);
  });

  it('passes benchmark options to VllmEngine', () => {
    const factory = new EngineFactory('info');
    const engine = factory.create('vllm', mockSshPool, 'info', {
      benchmark: {
        warmupRuns: 3,
        maxLatencyMs: 2000,
        minThroughput: 10,
        toolCallEnabled: true,
      },
    });

    expect(engine).toBeInstanceOf(VllmEngine);
  });

  it('passes deployment overrides to VllmEngine', () => {
    const factory = new EngineFactory('info');
    const overrides = { gpuMemoryUtilization: 0.75, maxModelLen: 8192 };
    const engine = factory.create('vllm', mockSshPool, 'info', {
      deploymentOverrides: overrides,
    });

    expect(engine).toBeInstanceOf(VllmEngine);
  });
});

describe('createEngine convenience wrapper', () => {
  it('delegates to EngineFactory.create', () => {
    const engine = createEngine('vllm', mockSshPool, 'warning');

    expect(engine).toBeInstanceOf(VllmEngine);
  });
});
