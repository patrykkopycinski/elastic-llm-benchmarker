import type { SSHClientPool } from '../services/ssh-client.js';
import type { InferenceEngine, EngineType, EngineFactoryOptions } from './engine-types.js';
import { VllmEngine } from './vllm-engine.js';
import type { VllmEngineOptions } from './vllm-engine.js';
import { OllamaEngine } from './ollama-engine.js';
import type { OllamaEngineOptions } from './ollama-engine.js';
import { createLogger } from '../utils/logger.js';

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Error thrown when an unsupported engine type is requested */
export class UnsupportedEngineError extends Error {
  constructor(
    public readonly engineType: string,
    public readonly supportedEngines: EngineType[],
  ) {
    super(
      `Unsupported engine type '${engineType}'. Supported engines: ${supportedEngines.join(', ')}`,
    );
    this.name = 'UnsupportedEngineError';
  }
}

// ─── Engine Factory ──────────────────────────────────────────────────────────

/**
 * Factory for creating inference engine instances.
 *
 * Provides a centralized way to instantiate engine adapters based on
 * the engine type. Supports the Strategy pattern, allowing the agent
 * to switch between engines without modifying the core orchestration logic.
 *
 * **Supported Engines:**
 * - `vllm`: VLLM (OpenAI-compatible API via Docker) — full-featured, production-ready
 * - `ollama`: Ollama (simplified model serving) — easier setup, limited tool calling
 *
 * @example
 * ```typescript
 * const factory = new EngineFactory();
 *
 * // Create a vLLM engine
 * const vllmEngine = factory.create('vllm', sshPool, 'info');
 *
 * // Create an Ollama engine
 * const ollamaEngine = factory.create('ollama', sshPool, 'info', {
 *   deployment: { useDocker: true },
 * });
 *
 * // Or use the options-based API
 * const engine = factory.createFromOptions({
 *   engineType: 'vllm',
 *   sshPool,
 *   logLevel: 'info',
 * });
 * ```
 */
export class EngineFactory {
  private readonly logger;

  /** List of all supported engine types */
  static readonly SUPPORTED_ENGINES: ReadonlyArray<EngineType> = ['vllm', 'ollama'];

  constructor(logLevel: string = 'info') {
    this.logger = createLogger(logLevel);
  }

  /**
   * Creates an inference engine instance by type.
   *
   * @param engineType - The engine type to create ('vllm' or 'ollama')
   * @param sshPool - SSH client pool for remote command execution
   * @param logLevel - Winston log level (default: 'info')
   * @param options - Engine-specific configuration options
   * @returns A configured InferenceEngine instance
   * @throws {UnsupportedEngineError} If the engine type is not supported
   */
  create(
    engineType: EngineType,
    sshPool: SSHClientPool,
    logLevel: string = 'info',
    options?: VllmEngineOptions | OllamaEngineOptions,
  ): InferenceEngine {
    this.logger.info(`Creating engine: ${engineType}`);

    switch (engineType) {
      case 'vllm':
        return new VllmEngine(sshPool, logLevel, options as VllmEngineOptions);

      case 'ollama':
        return new OllamaEngine(sshPool, logLevel, options as OllamaEngineOptions);

      default:
        throw new UnsupportedEngineError(
          engineType as string,
          [...EngineFactory.SUPPORTED_ENGINES],
        );
    }
  }

  /**
   * Creates an inference engine from a factory options object.
   *
   * @param factoryOptions - Options including engine type, SSH pool, and engine config
   * @returns A configured InferenceEngine instance
   * @throws {UnsupportedEngineError} If the engine type is not supported
   */
  createFromOptions(factoryOptions: EngineFactoryOptions): InferenceEngine {
    return this.create(
      factoryOptions.engineType,
      factoryOptions.sshPool,
      factoryOptions.logLevel,
      factoryOptions.engineOptions as VllmEngineOptions | OllamaEngineOptions,
    );
  }

  /**
   * Returns whether an engine type is supported.
   *
   * @param engineType - The engine type to check
   * @returns True if the engine type is supported
   */
  isSupported(engineType: string): engineType is EngineType {
    return (EngineFactory.SUPPORTED_ENGINES as ReadonlyArray<string>).includes(engineType);
  }

  /**
   * Returns the list of supported engine types.
   */
  getSupportedEngines(): ReadonlyArray<EngineType> {
    return EngineFactory.SUPPORTED_ENGINES;
  }

  /**
   * Returns the default engine type.
   * vLLM is the default as it's more mature and fully-featured.
   */
  getDefaultEngineType(): EngineType {
    return 'vllm';
  }
}

// ─── Convenience Function ────────────────────────────────────────────────────

/**
 * Convenience function to create an inference engine without instantiating
 * the factory directly.
 *
 * @param engineType - The engine type ('vllm' or 'ollama')
 * @param sshPool - SSH client pool
 * @param logLevel - Log level (default: 'info')
 * @param options - Engine-specific options
 * @returns A configured InferenceEngine instance
 */
export function createEngine(
  engineType: EngineType,
  sshPool: SSHClientPool,
  logLevel: string = 'info',
  options?: VllmEngineOptions | OllamaEngineOptions,
): InferenceEngine {
  const factory = new EngineFactory(logLevel);
  return factory.create(engineType, sshPool, logLevel, options);
}
