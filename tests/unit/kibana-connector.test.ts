import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { KibanaConnectorConfig } from '../../src/types/config.js';
import {
  KibanaConnectorService,
  KibanaConnectorError,
  KibanaConnectorCreationError,
  KibanaConnectorConfigError,
} from '../../src/services/kibana-connector.js';
import type {
  KibanaConnectorInfo,
  KibanaConnectorResult,
  KibanaConnectorStatus,
} from '../../src/services/kibana-connector.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createDefaultKibanaConfig(overrides: Partial<KibanaConnectorConfig> = {}): KibanaConnectorConfig {
  return {
    enabled: false,
    connectorNamePrefix: 'vllm-',
    requestTimeoutMs: 30_000,
    ...overrides,
  };
}

function createMockConnectorInfo(overrides: Partial<KibanaConnectorInfo> = {}): KibanaConnectorInfo {
  return {
    id: 'connector-123',
    name: 'vllm-meta-llama-Llama-3-70B',
    connectorTypeId: '.gen-ai',
    isNewlyCreated: true,
    apiUrl: 'https://abc123.ngrok-free.app/v1',
    defaultModel: 'meta-llama/Llama-3-70B',
    ...overrides,
  };
}

// Mock fetch globally
const mockFetch = vi.fn();

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KibanaConnectorService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Replace global fetch with mock
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('constructor', () => {
    it('initializes with default config', () => {
      const config = createDefaultKibanaConfig();
      const service = new KibanaConnectorService({ config });
      expect(service).toBeInstanceOf(KibanaConnectorService);
    });

    it('initializes with custom log level', () => {
      const config = createDefaultKibanaConfig();
      const service = new KibanaConnectorService({ config, logLevel: 'debug' });
      expect(service).toBeInstanceOf(KibanaConnectorService);
    });

    it('initializes with enabled config', () => {
      const config = createDefaultKibanaConfig({
        enabled: true,
        url: 'https://kibana.example.com',
        apiKey: 'test-api-key',
      });
      const service = new KibanaConnectorService({ config });
      expect(service.enabled).toBe(true);
    });
  });

  describe('enabled property', () => {
    it('returns false when service is disabled', () => {
      const config = createDefaultKibanaConfig({ enabled: false });
      const service = new KibanaConnectorService({ config });
      expect(service.enabled).toBe(false);
    });

    it('returns true when service is enabled', () => {
      const config = createDefaultKibanaConfig({ enabled: true });
      const service = new KibanaConnectorService({ config });
      expect(service.enabled).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('returns disabled status when service is disabled', () => {
      const config = createDefaultKibanaConfig({ enabled: false });
      const service = new KibanaConnectorService({ config });

      const status: KibanaConnectorStatus = service.getStatus();
      expect(status).toEqual({
        enabled: false,
        kibanaUrl: null,
        lastConnector: null,
      });
    });

    it('returns enabled status with Kibana URL', () => {
      const config = createDefaultKibanaConfig({
        enabled: true,
        url: 'https://kibana.example.com',
      });
      const service = new KibanaConnectorService({ config });

      const status = service.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.kibanaUrl).toBe('https://kibana.example.com');
      expect(status.lastConnector).toBeNull();
    });
  });

  describe('createConnector', () => {
    it('returns failure when service is disabled', async () => {
      const config = createDefaultKibanaConfig({ enabled: false });
      const service = new KibanaConnectorService({ config, logLevel: 'error' });

      const result: KibanaConnectorResult = await service.createConnector({
        apiUrl: 'https://abc123.ngrok-free.app',
        modelId: 'meta-llama/Llama-3-70B',
      });

      expect(result.success).toBe(false);
      expect(result.connector).toBeNull();
      expect(result.error).toBe('Kibana connector service is disabled');
    });

    it('returns failure when Kibana URL is not configured', async () => {
      const config = createDefaultKibanaConfig({ enabled: true });
      const service = new KibanaConnectorService({ config, logLevel: 'error' });

      const result = await service.createConnector({
        apiUrl: 'https://abc123.ngrok-free.app',
        modelId: 'meta-llama/Llama-3-70B',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Kibana URL is not configured');
    });

    it('returns failure when API key is not configured', async () => {
      const config = createDefaultKibanaConfig({
        enabled: true,
        url: 'https://kibana.example.com',
      });
      const service = new KibanaConnectorService({ config, logLevel: 'error' });

      const result = await service.createConnector({
        apiUrl: 'https://abc123.ngrok-free.app',
        modelId: 'meta-llama/Llama-3-70B',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Kibana API key is not configured');
    });

    it('creates a new connector when none exists', async () => {
      const config = createDefaultKibanaConfig({
        enabled: true,
        url: 'https://kibana.example.com',
        apiKey: 'test-api-key',
      });
      const service = new KibanaConnectorService({ config, logLevel: 'error' });

      // Mock: GET connectors returns empty list
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      // Mock: POST create connector returns new connector
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'connector-456',
          name: 'vllm-meta-llama-Llama-3-70B',
          connector_type_id: '.gen-ai',
        }),
      });

      const result = await service.createConnector({
        apiUrl: 'https://abc123.ngrok-free.app',
        modelId: 'meta-llama/Llama-3-70B',
      });

      expect(result.success).toBe(true);
      expect(result.connector).not.toBeNull();
      expect(result.connector!.id).toBe('connector-456');
      expect(result.connector!.isNewlyCreated).toBe(true);
      expect(result.connector!.apiUrl).toBe('https://abc123.ngrok-free.app/v1');
      expect(result.connector!.defaultModel).toBe('meta-llama/Llama-3-70B');
      expect(result.error).toBeNull();
    });

    it('reuses existing connector if found by name', async () => {
      const config = createDefaultKibanaConfig({
        enabled: true,
        url: 'https://kibana.example.com',
        apiKey: 'test-api-key',
      });
      const service = new KibanaConnectorService({ config, logLevel: 'error' });

      // Mock: GET connectors returns matching connector
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 'existing-connector-789',
            name: 'vllm-meta-llama-Llama-3-70B',
            connector_type_id: '.gen-ai',
            config: {
              apiUrl: 'https://old-url.ngrok-free.app/v1/chat/completions',
              defaultModel: 'meta-llama/Llama-3-70B',
            },
          },
        ],
      });

      const result = await service.createConnector({
        apiUrl: 'https://abc123.ngrok-free.app',
        modelId: 'meta-llama/Llama-3-70B',
      });

      expect(result.success).toBe(true);
      expect(result.connector).not.toBeNull();
      expect(result.connector!.id).toBe('existing-connector-789');
      expect(result.connector!.isNewlyCreated).toBe(false);
      // Should only have called fetch once (GET connectors), not POST
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('handles connector creation API failure gracefully', async () => {
      const config = createDefaultKibanaConfig({
        enabled: true,
        url: 'https://kibana.example.com',
        apiKey: 'test-api-key',
      });
      const service = new KibanaConnectorService({ config, logLevel: 'error' });

      // Mock: GET connectors returns empty list
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      // Mock: POST create connector fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'Insufficient privileges',
      });

      const result = await service.createConnector({
        apiUrl: 'https://abc123.ngrok-free.app',
        modelId: 'meta-llama/Llama-3-70B',
      });

      expect(result.success).toBe(false);
      expect(result.connector).toBeNull();
      expect(result.error).toContain('403');
    });

    it('handles network errors gracefully', async () => {
      const config = createDefaultKibanaConfig({
        enabled: true,
        url: 'https://kibana.example.com',
        apiKey: 'test-api-key',
      });
      const service = new KibanaConnectorService({ config, logLevel: 'error' });

      // Mock: GET connectors throws network error
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      // Even if search fails, it should still try to create
      // Mock: POST create connector also fails
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await service.createConnector({
        apiUrl: 'https://abc123.ngrok-free.app',
        modelId: 'meta-llama/Llama-3-70B',
      });

      expect(result.success).toBe(false);
      expect(result.connector).toBeNull();
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('sends correct request headers and body', async () => {
      const config = createDefaultKibanaConfig({
        enabled: true,
        url: 'https://kibana.example.com',
        apiKey: 'my-api-key-123',
      });
      const service = new KibanaConnectorService({ config, logLevel: 'error' });

      // Mock: GET connectors returns empty
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      // Mock: POST create connector
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'new-connector' }),
      });

      await service.createConnector({
        apiUrl: 'https://abc123.ngrok-free.app',
        modelId: 'test-org/test-model',
      });

      // Verify GET request
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const getCall = mockFetch.mock.calls[0]!;
      expect(getCall[0]).toBe('https://kibana.example.com/api/actions/connectors');
      expect(getCall[1].headers['Authorization']).toBe('ApiKey my-api-key-123');
      expect(getCall[1].headers['kbn-xsrf']).toBe('true');

      // Verify POST request
      const postCall = mockFetch.mock.calls[1]!;
      expect(postCall[0]).toBe('https://kibana.example.com/api/actions/connector');
      expect(postCall[1].method).toBe('POST');
      expect(postCall[1].headers['Authorization']).toBe('ApiKey my-api-key-123');
      expect(postCall[1].headers['kbn-xsrf']).toBe('true');

      const body = JSON.parse(postCall[1].body);
      expect(body.connector_type_id).toBe('.gen-ai');
      expect(body.name).toBe('vllm-test-org-test-model');
      expect(body.config.apiProvider).toBe('Other');
      expect(body.config.apiUrl).toBe('https://abc123.ngrok-free.app/v1/chat/completions');
      expect(body.config.defaultModel).toBe('test-org/test-model');
      expect(body.secrets.apiKey).toBe('vllm-no-key-required');
    });

    it('normalizes API URL to include /v1 suffix', async () => {
      const config = createDefaultKibanaConfig({
        enabled: true,
        url: 'https://kibana.example.com',
        apiKey: 'test-api-key',
      });
      const service = new KibanaConnectorService({ config, logLevel: 'error' });

      // Test URL without /v1
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'c1' }),
      });

      const result1 = await service.createConnector({
        apiUrl: 'https://abc123.ngrok-free.app',
        modelId: 'model-1',
      });
      expect(result1.success).toBe(true);
      expect(result1.connector!.apiUrl).toBe('https://abc123.ngrok-free.app/v1');

      // Test URL already with /v1
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'c2' }),
      });

      const result2 = await service.createConnector({
        apiUrl: 'https://abc123.ngrok-free.app/v1',
        modelId: 'model-2',
      });
      expect(result2.success).toBe(true);
      expect(result2.connector!.apiUrl).toBe('https://abc123.ngrok-free.app/v1');
    });

    it('supports custom connector name', async () => {
      const config = createDefaultKibanaConfig({
        enabled: true,
        url: 'https://kibana.example.com',
        apiKey: 'test-api-key',
      });
      const service = new KibanaConnectorService({ config, logLevel: 'error' });

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'custom-connector' }),
      });

      const result = await service.createConnector({
        apiUrl: 'https://abc123.ngrok-free.app',
        modelId: 'test-model',
        connectorName: 'my-custom-name',
      });

      expect(result.success).toBe(true);
      expect(result.connector!.name).toBe('my-custom-name');
    });

    it('updates getStatus with lastConnector after creation', async () => {
      const config = createDefaultKibanaConfig({
        enabled: true,
        url: 'https://kibana.example.com',
        apiKey: 'test-api-key',
      });
      const service = new KibanaConnectorService({ config, logLevel: 'error' });

      // Before creation
      expect(service.getStatus().lastConnector).toBeNull();

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'new-connector' }),
      });

      await service.createConnector({
        apiUrl: 'https://abc123.ngrok-free.app',
        modelId: 'test-model',
      });

      // After creation
      const status = service.getStatus();
      expect(status.lastConnector).not.toBeNull();
      expect(status.lastConnector!.id).toBe('new-connector');
    });
  });
});

describe('KibanaConnectorError', () => {
  it('creates error with message', () => {
    const error = new KibanaConnectorError('test error');
    expect(error.name).toBe('KibanaConnectorError');
    expect(error.message).toBe('test error');
  });

  it('includes status code', () => {
    const error = new KibanaConnectorError('forbidden', 403);
    expect(error.statusCode).toBe(403);
  });

  it('includes cause error', () => {
    const cause = new Error('root cause');
    const error = new KibanaConnectorError('test error', undefined, cause);
    expect(error.cause).toBe(cause);
  });
});

describe('KibanaConnectorCreationError', () => {
  it('creates error with connector name', () => {
    const error = new KibanaConnectorCreationError('my-connector');
    expect(error.name).toBe('KibanaConnectorCreationError');
    expect(error.connectorName).toBe('my-connector');
    expect(error.message).toContain('my-connector');
  });

  it('includes cause error message', () => {
    const cause = new Error('API returned 500');
    const error = new KibanaConnectorCreationError('my-connector', 500, cause);
    expect(error.message).toContain('API returned 500');
    expect(error.statusCode).toBe(500);
  });
});

describe('KibanaConnectorConfigError', () => {
  it('creates error with reason', () => {
    const error = new KibanaConnectorConfigError('URL not set');
    expect(error.name).toBe('KibanaConnectorConfigError');
    expect(error.message).toContain('URL not set');
  });
});

describe('KibanaConnectorService with runKibanaEvalNode', () => {
  function createConfig(connectorService?: unknown) {
    return { configurable: { kibanaConnectorService: connectorService } };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('runKibanaEvalNode works with null service', async () => {
    const { runKibanaEvalNode } = await import('../../src/agent/nodes.js');

    const state = createMinimalGraphState();
    const result = await runKibanaEvalNode(state, createConfig());
    expect(result.currentState).toBe('evaluating_model');
    expect(result.kibanaConnectorId).toBeNull();
  });

  it('runKibanaEvalNode works with disabled service', async () => {
    const { runKibanaEvalNode } = await import('../../src/agent/nodes.js');
    const config = createDefaultKibanaConfig({ enabled: false });
    const service = new KibanaConnectorService({ config, logLevel: 'error' });

    const state = createMinimalGraphState();
    const result = await runKibanaEvalNode(state, createConfig(service));
    expect(result.currentState).toBe('evaluating_model');
    expect(result.kibanaConnectorId).toBeNull();
  });

  it('runKibanaEvalNode skips when no tunnel URL', async () => {
    const { runKibanaEvalNode } = await import('../../src/agent/nodes.js');
    const config = createDefaultKibanaConfig({
      enabled: true,
      url: 'https://kibana.example.com',
      apiKey: 'test-key',
    });
    const service = new KibanaConnectorService({ config, logLevel: 'error' });

    const state = createMinimalGraphState({ tunnelUrl: null });
    const result = await runKibanaEvalNode(state, createConfig(service));
    expect(result.currentState).toBe('evaluating_model');
    expect(result.kibanaConnectorId).toBeNull();
  });

  it('runKibanaEvalNode skips when no current model', async () => {
    const { runKibanaEvalNode } = await import('../../src/agent/nodes.js');
    const config = createDefaultKibanaConfig({
      enabled: true,
      url: 'https://kibana.example.com',
      apiKey: 'test-key',
    });
    const service = new KibanaConnectorService({ config, logLevel: 'error' });

    const state = createMinimalGraphState({
      tunnelUrl: 'https://abc123.ngrok-free.app',
      currentModel: null,
    });
    const result = await runKibanaEvalNode(state, createConfig(service));
    expect(result.currentState).toBe('evaluating_model');
    expect(result.kibanaConnectorId).toBeNull();
  });

  it('runKibanaEvalNode creates connector when tunnel and model available', async () => {
    const { runKibanaEvalNode } = await import('../../src/agent/nodes.js');
    const config = createDefaultKibanaConfig({
      enabled: true,
      url: 'https://kibana.example.com',
      apiKey: 'test-key',
    });
    const service = new KibanaConnectorService({ config, logLevel: 'error' });

    // Mock successful connector creation
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'kibana-connector-id' }),
    });

    const state = createMinimalGraphState({
      tunnelUrl: 'https://abc123.ngrok-free.app',
      currentModel: {
        id: 'meta-llama/Llama-3-70B',
        name: 'Llama 3 70B',
        architecture: 'llama',
        contextWindow: 128_000,
        license: 'llama3',
        parameterCount: 70_000_000_000,
        quantizations: [],
        supportsToolCalling: true,
      },
    });
    const result = await runKibanaEvalNode(state, createConfig(service));
    expect(result.currentState).toBe('evaluating_model');
    expect(result.kibanaConnectorId).toBe('kibana-connector-id');
    expect(result.error).toBeNull();
  });

  it('runKibanaEvalNode handles connector creation failure gracefully', async () => {
    const { runKibanaEvalNode } = await import('../../src/agent/nodes.js');
    const config = createDefaultKibanaConfig({
      enabled: true,
      url: 'https://kibana.example.com',
      apiKey: 'test-key',
    });
    const service = new KibanaConnectorService({ config, logLevel: 'error' });

    // Mock failed connector creation
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const state = createMinimalGraphState({
      tunnelUrl: 'https://abc123.ngrok-free.app',
      currentModel: {
        id: 'meta-llama/Llama-3-70B',
        name: 'Llama 3 70B',
        architecture: 'llama',
        contextWindow: 128_000,
        license: 'llama3',
        parameterCount: 70_000_000_000,
        quantizations: [],
        supportsToolCalling: true,
      },
    });
    const result = await runKibanaEvalNode(state, createConfig(service));
    // Should NOT error out, just continue without connector
    expect(result.currentState).toBe('evaluating_model');
    expect(result.kibanaConnectorId).toBeNull();
    expect(result.error).toBeNull();
  });

  it('runKibanaEvalNode works without connector when configurable is empty', async () => {
    const { runKibanaEvalNode } = await import('../../src/agent/nodes.js');

    const state = createMinimalGraphState();
    const result = await runKibanaEvalNode(state, { configurable: {} });

    expect(result.currentState).toBe('evaluating_model');
    expect(result.kibanaConnectorId).toBeNull();
  });
});

// ─── Minimal state helper for agent node tests ──────────────────────────────

function createMinimalGraphState(overrides: Record<string, unknown> = {}) {
  return {
    currentState: 'running_kibana_eval',
    discoveredModels: [],
    currentModel: null,
    results: [],
    evaluatedModelIds: [],
    error: null,
    errorCount: 0,
    lastSuccessTimestamp: null,
    skippedModelIds: [],
    circuitBreakerSnapshot: null,
    recoveryRecords: [],
    lastErrorCategory: null,
    currentModelRetryCount: 0,
    tunnelUrl: null,
    kibanaConnectorId: null,
    ...overrides,
  };
}
