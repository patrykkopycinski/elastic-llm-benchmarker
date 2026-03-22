import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelDiscoveryService } from '../../src/services/model-discovery.js';

// ─── Mock Helpers ────────────────────────────────────────────────────────────

/**
 * Creates a mock HuggingFace model API entry.
 */
function createMockHFModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'test-org/test-model',
    id: 'test-org/test-model',
    modelId: 'test-org/test-model',
    author: 'test-org',
    private: false,
    gated: false,
    disabled: false,
    pipeline_tag: 'text-generation',
    library_name: 'transformers',
    tags: ['text-generation', 'license:apache-2.0', 'transformers'],
    config: {
      model_type: 'llama',
      architectures: ['LlamaForCausalLM'],
    },
    siblings: [{ rfilename: 'config.json' }, { rfilename: 'model.safetensors' }],
    ...overrides,
  };
}

/**
 * Creates a mock config.json response.
 */
function createMockConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_type: 'llama',
    architectures: ['LlamaForCausalLM'],
    max_position_embeddings: 131072,
    hidden_size: 4096,
    num_hidden_layers: 32,
    num_attention_heads: 32,
    intermediate_size: 11008,
    ...overrides,
  };
}

/**
 * Sets up global fetch mock with configured responses.
 */
function setupFetchMock(responses: {
  searchResults?: Record<string, unknown>[][];
  configs?: Map<string, Record<string, unknown>>;
}) {
  const { searchResults = [[]], configs = new Map() } = responses;
  let searchPage = 0;

  return vi.fn().mockImplementation((url: string) => {
    const urlStr = typeof url === 'string' ? url : String(url);

    // Model search endpoint
    if (urlStr.includes('/api/models?')) {
      const page = searchResults[searchPage] ?? [];
      searchPage++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(page),
      });
    }

    // Config.json endpoint
    if (urlStr.includes('/resolve/main/config.json')) {
      const modelId = urlStr
        .replace('https://huggingface.co/api/models/', '')
        .replace('/resolve/main/config.json', '');
      const config = configs.get(modelId);
      if (config) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(config),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
      });
    }

    // Single model info endpoint
    if (urlStr.includes('/api/models/') && !urlStr.includes('?')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(createMockHFModel()),
      });
    }

    return Promise.resolve({ ok: false, status: 404 });
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ModelDiscoveryService', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with empty evaluated models', () => {
      const service = new ModelDiscoveryService('test-token', [], 'error');
      expect(service.getEvaluatedModelIds()).toEqual([]);
    });

    it('should initialize with provided evaluated model IDs', () => {
      const service = new ModelDiscoveryService('test-token', ['model-a', 'model-b'], 'error');
      expect(service.getEvaluatedModelIds()).toEqual(['model-a', 'model-b']);
    });
  });

  describe('markEvaluated and isEvaluated', () => {
    it('should track evaluated models', () => {
      const service = new ModelDiscoveryService('test-token', [], 'error');

      expect(service.isEvaluated('test-model')).toBe(false);

      service.markEvaluated('test-model');
      expect(service.isEvaluated('test-model')).toBe(true);
    });

    it('should not duplicate evaluated model IDs', () => {
      const service = new ModelDiscoveryService('test-token', [], 'error');

      service.markEvaluated('test-model');
      service.markEvaluated('test-model');

      expect(service.getEvaluatedModelIds()).toEqual(['test-model']);
    });

    it('should return sorted evaluated model IDs', () => {
      const service = new ModelDiscoveryService('test-token', [], 'error');

      service.markEvaluated('model-c');
      service.markEvaluated('model-a');
      service.markEvaluated('model-b');

      expect(service.getEvaluatedModelIds()).toEqual(['model-a', 'model-b', 'model-c']);
    });
  });

  describe('discover', () => {
    it('should discover models that meet all criteria', async () => {
      const mockModel = createMockHFModel({
        id: 'org/llama-128k',
        tags: ['text-generation', 'license:apache-2.0', 'transformers'],
        config: { model_type: 'llama', architectures: ['LlamaForCausalLM'] },
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/llama-128k', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover({ minContextWindow: 128000 });

      expect(result.models).toHaveLength(1);
      expect(result.models[0]!.id).toBe('org/llama-128k');
      expect(result.models[0]!.architecture).toBe('llama');
      expect(result.models[0]!.contextWindow).toBe(131072);
      expect(result.models[0]!.license).toBe('apache-2.0');
    });

    it('should reject models with insufficient context window', async () => {
      const mockModel = createMockHFModel({
        id: 'org/small-ctx-model',
        tags: ['text-generation', 'license:mit', 'transformers'],
        config: { model_type: 'llama' },
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 4096 });

      const configs = new Map([['org/small-ctx-model', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover({ minContextWindow: 128000 });

      expect(result.models).toHaveLength(0);
      expect(result.totalRejected).toBe(1);
    });

    it('should reject models with non-open-source license', async () => {
      const mockModel = createMockHFModel({
        id: 'org/proprietary-model',
        tags: ['text-generation', 'license:proprietary', 'transformers'],
        config: { model_type: 'llama' },
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/proprietary-model', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models).toHaveLength(0);
      expect(result.totalRejected).toBe(1);
    });

    it('should reject models with incompatible architecture', async () => {
      const mockModel = createMockHFModel({
        id: 'org/vision-model',
        tags: ['text-generation', 'license:mit', 'transformers'],
        config: { model_type: 'vit', architectures: ['ViTForImageClassification'] },
      });
      const mockConfig = createMockConfig({
        model_type: 'vit',
        architectures: ['ViTForImageClassification'],
        max_position_embeddings: 131072,
      });

      const configs = new Map([['org/vision-model', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models).toHaveLength(0);
      expect(result.totalRejected).toBe(1);
    });

    it('should skip already-evaluated models', async () => {
      const mockModel = createMockHFModel({
        id: 'org/already-tested',
        tags: ['text-generation', 'license:apache-2.0', 'transformers'],
        config: { model_type: 'llama' },
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/already-tested', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', ['org/already-tested'], 'error');
      const result = await service.discover();

      expect(result.models).toHaveLength(0);
      expect(result.totalRejected).toBe(1);
    });

    it('should respect the limit option', async () => {
      const models = [
        createMockHFModel({ id: 'org/model-1', tags: ['text-generation', 'license:apache-2.0'] }),
        createMockHFModel({ id: 'org/model-2', tags: ['text-generation', 'license:apache-2.0'] }),
        createMockHFModel({ id: 'org/model-3', tags: ['text-generation', 'license:apache-2.0'] }),
      ];
      const configs = new Map([
        ['org/model-1', createMockConfig()],
        ['org/model-2', createMockConfig()],
        ['org/model-3', createMockConfig()],
      ]);

      global.fetch = setupFetchMock({
        searchResults: [models],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover({ limit: 2 });

      expect(result.models).toHaveLength(2);
    });

    it('should include discovery metadata in result', async () => {
      global.fetch = setupFetchMock({ searchResults: [[]] }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.totalScanned).toBe(0);
      expect(result.totalRejected).toBe(0);
      expect(result.timestamp).toBeTruthy();
      expect(new Date(result.timestamp).getTime()).not.toBeNaN();
    });

    it('should handle fetch errors gracefully', async () => {
      const mockModel = createMockHFModel({
        id: 'org/error-model',
        tags: ['text-generation', 'license:apache-2.0', 'transformers'],
        config: { model_type: 'llama' },
      });

      // Config fetch fails
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/api/models?')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([mockModel]),
          });
        }
        if (url.includes('/resolve/main/config.json')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      global.fetch = fetchMock as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models).toHaveLength(0);
      expect(result.totalRejected).toBe(1);
      expect(result.totalScanned).toBe(1);
    });

    it('should filter out private models', async () => {
      const mockModel = createMockHFModel({
        id: 'org/private-model',
        private: true,
      });

      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models).toHaveLength(0);
      expect(result.totalScanned).toBe(0);
    });

    it('should filter out gated models when includeGated is false', async () => {
      const mockModel = createMockHFModel({
        id: 'org/gated-model',
        gated: true,
        tags: ['text-generation', 'license:apache-2.0'],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/gated-model', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover({ includeGated: false });

      expect(result.totalScanned).toBe(0);
    });
  });

  describe('fetchModelConfig', () => {
    it('should fetch and return model config', async () => {
      const mockConfig = createMockConfig({
        max_position_embeddings: 131072,
        model_type: 'llama',
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockConfig),
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const config = await service.fetchModelConfig('test-org/test-model');

      expect(config).not.toBeNull();
      expect(config!.max_position_embeddings).toBe(131072);
      expect(config!.model_type).toBe('llama');
    });

    it('should return null for missing config', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const config = await service.fetchModelConfig('test-org/no-config');

      expect(config).toBeNull();
    });

    it('should return null on network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const config = await service.fetchModelConfig('test-org/error');

      expect(config).toBeNull();
    });
  });

  describe('fetchModelInfo', () => {
    it('should fetch model info from HuggingFace API', async () => {
      const mockModel = createMockHFModel({ id: 'test-org/test-model' });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockModel),
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const info = await service.fetchModelInfo('test-org/test-model');

      expect(info).not.toBeNull();
      expect(info!.id).toBe('test-org/test-model');
    });

    it('should return null for non-existent model', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const info = await service.fetchModelInfo('non-existent/model');

      expect(info).toBeNull();
    });
  });

  describe('context window extraction', () => {
    it('should use max_position_embeddings from config', async () => {
      const mockModel = createMockHFModel({
        id: 'org/model-128k',
        tags: ['text-generation', 'license:apache-2.0'],
      });
      const mockConfig = createMockConfig({
        max_position_embeddings: 131072,
      });

      const configs = new Map([['org/model-128k', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover({ minContextWindow: 128000 });

      expect(result.models).toHaveLength(1);
      expect(result.models[0]!.contextWindow).toBe(131072);
    });

    it('should use max_sequence_length as fallback', async () => {
      const mockModel = createMockHFModel({
        id: 'org/model-seq',
        tags: ['text-generation', 'license:apache-2.0'],
      });
      const mockConfig = createMockConfig({
        max_position_embeddings: undefined,
        max_sequence_length: 131072,
      });
      // Remove max_position_embeddings
      delete mockConfig.max_position_embeddings;

      const configs = new Map([['org/model-seq', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover({ minContextWindow: 128000 });

      expect(result.models).toHaveLength(1);
      expect(result.models[0]!.contextWindow).toBe(131072);
    });

    it('should handle rope_scaling to extend context window', async () => {
      const mockModel = createMockHFModel({
        id: 'org/model-rope',
        tags: ['text-generation', 'license:apache-2.0'],
      });
      const mockConfig = createMockConfig({
        max_position_embeddings: 32768,
        rope_scaling: {
          type: 'dynamic',
          factor: 4.0,
          original_max_position_embeddings: 32768,
        },
      });

      const configs = new Map([['org/model-rope', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover({ minContextWindow: 128000 });

      expect(result.models).toHaveLength(1);
      expect(result.models[0]!.contextWindow).toBe(131072);
    });
  });

  describe('architecture detection', () => {
    it('should detect llama architecture', async () => {
      const mockModel = createMockHFModel({
        id: 'org/llama-model',
        tags: ['text-generation', 'license:mit'],
        config: { model_type: 'llama' },
      });
      const mockConfig = createMockConfig({
        model_type: 'llama',
        max_position_embeddings: 131072,
      });

      const configs = new Map([['org/llama-model', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models[0]!.architecture).toBe('llama');
    });

    it('should detect MoE architecture (mixtral)', async () => {
      const mockModel = createMockHFModel({
        id: 'org/mixtral-model',
        tags: ['text-generation', 'license:apache-2.0'],
        config: { model_type: 'mixtral' },
      });
      const mockConfig = createMockConfig({
        model_type: 'mixtral',
        max_position_embeddings: 131072,
        num_local_experts: 8,
        num_experts_per_tok: 2,
      });

      const configs = new Map([['org/mixtral-model', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models).toHaveLength(1);
      expect(result.models[0]!.architecture).toBe('mixtral');
    });

    it('should normalize architecture names from class names', async () => {
      const mockModel = createMockHFModel({
        id: 'org/model-classname',
        tags: ['text-generation', 'license:mit'],
        config: { architectures: ['Qwen2ForCausalLM'] },
      });
      const mockConfig = createMockConfig({
        model_type: undefined,
        architectures: ['Qwen2ForCausalLM'],
        max_position_embeddings: 131072,
      });
      delete mockConfig.model_type;

      const configs = new Map([['org/model-classname', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models).toHaveLength(1);
      expect(result.models[0]!.architecture).toBe('qwen2');
    });
  });

  describe('quantization extraction', () => {
    it('should extract quantization from config', async () => {
      const mockModel = createMockHFModel({
        id: 'org/quant-model',
        tags: ['text-generation', 'license:apache-2.0'],
      });
      const mockConfig = createMockConfig({
        max_position_embeddings: 131072,
        quantization_config: {
          quant_method: 'gptq',
          bits: 4,
        },
      });

      const configs = new Map([['org/quant-model', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models[0]!.quantizations).toContain('gptq');
      expect(result.models[0]!.quantizations).toContain('gptq-4bit');
    });

    it('should extract quantization from tags', async () => {
      const mockModel = createMockHFModel({
        id: 'org/awq-model',
        tags: ['text-generation', 'license:apache-2.0', 'awq', 'int4'],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/awq-model', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models[0]!.quantizations).toContain('awq');
      expect(result.models[0]!.quantizations).toContain('int4');
    });

    it('should detect quantization from model file siblings', async () => {
      const mockModel = createMockHFModel({
        id: 'org/gguf-model',
        tags: ['text-generation', 'license:mit'],
        siblings: [{ rfilename: 'config.json' }, { rfilename: 'model-q4_k_m.gguf' }],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/gguf-model', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models[0]!.quantizations).toContain('gguf');
    });

    it('should default to fp16 when no quantization info found', async () => {
      const mockModel = createMockHFModel({
        id: 'org/base-model',
        tags: ['text-generation', 'license:mit'],
        siblings: [{ rfilename: 'config.json' }, { rfilename: 'model.safetensors' }],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/base-model', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models[0]!.quantizations).toContain('fp16');
    });
  });

  describe('tool calling detection', () => {
    it('should detect tool calling from tags', async () => {
      const mockModel = createMockHFModel({
        id: 'org/tool-model',
        tags: ['text-generation', 'license:apache-2.0', 'tool-calling'],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/tool-model', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models[0]!.supportsToolCalling).toBe(true);
    });

    it('should detect tool calling from instruct model names', async () => {
      const mockModel = createMockHFModel({
        id: 'org/Llama-3-Instruct',
        tags: ['text-generation', 'license:apache-2.0'],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/Llama-3-Instruct', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models[0]!.supportsToolCalling).toBe(true);
    });

    it('should not assume base models support tool calling', async () => {
      const mockModel = createMockHFModel({
        id: 'org/llama-3-base',
        tags: ['text-generation', 'license:apache-2.0'],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/llama-3-base', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models[0]!.supportsToolCalling).toBe(false);
    });
  });

  describe('parameter count extraction', () => {
    it('should extract parameter count from model name (e.g., 70B)', async () => {
      const mockModel = createMockHFModel({
        id: 'org/Llama-70B-base',
        tags: ['text-generation', 'license:apache-2.0'],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/Llama-70B-base', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models[0]!.parameterCount).toBe(70_000_000_000);
    });

    it('should extract parameter count from tags', async () => {
      const mockModel = createMockHFModel({
        id: 'org/model',
        tags: ['text-generation', 'license:apache-2.0', 'params:7000000000'],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/model', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models[0]!.parameterCount).toBe(7000000000);
    });

    it('should return null when parameter count is unavailable', async () => {
      const mockModel = createMockHFModel({
        id: 'org/model-no-params',
        tags: ['text-generation', 'license:apache-2.0'],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/model-no-params', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models[0]!.parameterCount).toBeNull();
    });
  });

  describe('license validation', () => {
    const openSourceLicenses = [
      'apache-2.0',
      'mit',
      'gpl-3.0',
      'llama3',
      'llama3.1',
      'gemma',
      'bigscience-openrail-m',
      'cc-by-4.0',
    ];

    for (const license of openSourceLicenses) {
      it(`should accept open-source license: ${license}`, async () => {
        const mockModel = createMockHFModel({
          id: `org/model-${license}`,
          tags: ['text-generation', `license:${license}`],
        });
        const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

        const configs = new Map([[`org/model-${license}`, mockConfig]]);
        global.fetch = setupFetchMock({
          searchResults: [[mockModel]],
          configs,
        }) as typeof global.fetch;

        const service = new ModelDiscoveryService('test-token', [], 'error');
        const result = await service.discover();

        expect(result.models).toHaveLength(1);
      });
    }

    it('should reject proprietary license', async () => {
      const mockModel = createMockHFModel({
        id: 'org/proprietary',
        tags: ['text-generation', 'license:proprietary'],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/proprietary', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models).toHaveLength(0);
    });

    it('should reject models without license tag', async () => {
      const mockModel = createMockHFModel({
        id: 'org/no-license',
        tags: ['text-generation'],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['org/no-license', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models).toHaveLength(0);
    });
  });

  describe('authentication', () => {
    it('should include authorization header when token is provided', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('my-secret-token', [], 'error');
      await service.discover();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-secret-token',
          }),
        }),
      );
    });
  });

  describe('model name extraction', () => {
    it('should extract model name from ID', async () => {
      const mockModel = createMockHFModel({
        id: 'meta-llama/Llama-3.1-70B-Instruct',
        tags: ['text-generation', 'license:llama3.1'],
      });
      const mockConfig = createMockConfig({ max_position_embeddings: 131072 });

      const configs = new Map([['meta-llama/Llama-3.1-70B-Instruct', mockConfig]]);
      global.fetch = setupFetchMock({
        searchResults: [[mockModel]],
        configs,
      }) as typeof global.fetch;

      const service = new ModelDiscoveryService('test-token', [], 'error');
      const result = await service.discover();

      expect(result.models[0]!.name).toBe('Llama-3.1-70B-Instruct');
    });
  });
});
