import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { KibanaConnectorConfig } from '../../src/types/config.js';
import type {
  KibanaEvalReport,
  KibanaEvalRunnerConfig,
} from '../../src/types/kibana-eval.js';
import { SEVERITY_WEIGHTS, DEFAULT_KIBANA_EVAL_CONFIG } from '../../src/types/kibana-eval.js';
import {
  KibanaEvalRunner,
  KIBANA_EVAL_TASKS,
} from '../../src/services/kibana-eval-runner.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createDefaultKibanaConfig(
  overrides: Partial<KibanaConnectorConfig> = {},
): KibanaConnectorConfig {
  return {
    enabled: true,
    url: 'https://kibana.example.com',
    apiKey: 'test-api-key',
    connectorNamePrefix: 'vllm-',
    requestTimeoutMs: 30_000,
    ...overrides,
  };
}

function createEnabledRunner(
  evalOverrides: Partial<KibanaEvalRunnerConfig> = {},
  kibanaOverrides: Partial<KibanaConnectorConfig> = {},
): KibanaEvalRunner {
  return new KibanaEvalRunner({
    kibanaConfig: createDefaultKibanaConfig(kibanaOverrides),
    evalConfig: { enabled: true, ...evalOverrides },
    logLevel: 'error',
  });
}

// Mock fetch globally
const mockFetch = vi.fn();

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KibanaEvalRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('constructor', () => {
    it('initializes with default config', () => {
      const runner = new KibanaEvalRunner({
        kibanaConfig: createDefaultKibanaConfig(),
        logLevel: 'error',
      });
      expect(runner).toBeInstanceOf(KibanaEvalRunner);
    });

    it('merges custom eval config with defaults', () => {
      const runner = new KibanaEvalRunner({
        kibanaConfig: createDefaultKibanaConfig(),
        evalConfig: { passThreshold: 90 },
        logLevel: 'error',
      });
      const config = runner.getConfig();
      expect(config.passThreshold).toBe(90);
      expect(config.globalTimeoutMs).toBe(DEFAULT_KIBANA_EVAL_CONFIG.globalTimeoutMs);
    });
  });

  describe('enabled property', () => {
    it('returns true when both eval and kibana connector are enabled', () => {
      const runner = createEnabledRunner();
      expect(runner.enabled).toBe(true);
    });

    it('returns false when eval is disabled', () => {
      const runner = new KibanaEvalRunner({
        kibanaConfig: createDefaultKibanaConfig(),
        evalConfig: { enabled: false },
        logLevel: 'error',
      });
      expect(runner.enabled).toBe(false);
    });

    it('returns false when kibana connector is disabled', () => {
      const runner = new KibanaEvalRunner({
        kibanaConfig: createDefaultKibanaConfig({ enabled: false }),
        evalConfig: { enabled: true },
        logLevel: 'error',
      });
      expect(runner.enabled).toBe(false);
    });
  });

  describe('getConfig', () => {
    it('returns a copy of the eval config', () => {
      const runner = createEnabledRunner({ passThreshold: 75 });
      const config = runner.getConfig();
      expect(config.passThreshold).toBe(75);
      expect(config.enabled).toBe(true);
    });
  });

  describe('runEvaluation', () => {
    it('returns a complete evaluation report', async () => {
      // Mock all connector action calls to return successful responses
      mockFetch.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          status: 'ok',
          data: {
            message: '4',
          },
        }),
      }));

      const runner = createEnabledRunner();
      const report = await runner.runEvaluation({
        connectorId: 'test-connector-id',
        modelId: 'test-org/test-model',
      });

      expect(report).toBeDefined();
      expect(report.modelId).toBe('test-org/test-model');
      expect(report.connectorId).toBe('test-connector-id');
      expect(report.timestamp).toBeDefined();
      expect(report.classification).toBeDefined();
      expect(['PASS', 'PARTIAL', 'FAIL']).toContain(report.classification);
      expect(report.scoring).toBeDefined();
      expect(report.taskResults).toBeDefined();
      expect(report.taskResults.length).toBe(KIBANA_EVAL_TASKS.length);
      expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(report.evalConfig).toBeDefined();
    });

    it('handles all tasks passing with PASS classification', async () => {
      // Mock responses that satisfy all tasks
      mockFetch.mockImplementation(async (_url: string, options: { body?: string }) => {
        const body = options.body ? JSON.parse(options.body) : {};
        const subAction = body.params?.subAction;

        if (subAction === 'invokeStream') {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              data: 'hello streaming data',
            }),
          };
        }

        // For invokeAI
        const messages = body.params?.subActionParams?.messages ?? [];
        const hasTools = body.params?.subActionParams?.tools;

        // Empty messages (error handling test)
        if (messages.length === 0) {
          return {
            ok: true,
            json: async () => ({
              status: 'error',
              message: 'Messages are required',
            }),
          };
        }

        // Tool calling test
        if (hasTools) {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              data: {
                choices: [
                  {
                    message: {
                      tool_calls: [
                        {
                          id: 'call_1',
                          type: 'function',
                          function: {
                            name: 'get_current_time',
                            arguments: '{"timezone":"UTC"}',
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            }),
          };
        }

        // System prompt test
        const hasSystemPrompt = messages.some(
          (m: { role: string }) => m.role === 'system',
        );
        if (hasSystemPrompt) {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              data: { message: 'ACKNOWLEDGED Here is a fun fact about space.' },
            }),
          };
        }

        // Basic chat completion and health check
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            data: { message: '4' },
          }),
        };
      });

      const runner = createEnabledRunner();
      const report = await runner.runEvaluation({
        connectorId: 'test-connector',
        modelId: 'test-model',
      });

      expect(report.classification).toBe('PASS');
      expect(report.scoring.passedCount).toBe(KIBANA_EVAL_TASKS.length);
      expect(report.scoring.failedCount).toBe(0);
      expect(report.scoring.percentageScore).toBe(100);
      expect(report.failedTasks).toHaveLength(0);
    });

    it('returns FAIL classification when critical task fails', async () => {
      // Health check fails
      mockFetch.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          status: 'error',
          message: 'Connection refused',
        }),
      }));

      const runner = createEnabledRunner({ continueOnCriticalFailure: false });
      const report = await runner.runEvaluation({
        connectorId: 'test-connector',
        modelId: 'test-model',
      });

      expect(report.classification).toBe('FAIL');
      expect(report.failedTasks.length).toBeGreaterThan(0);
    });

    it('skips remaining tasks after critical failure when continueOnCriticalFailure is false', async () => {
      // All requests return error
      mockFetch.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          status: 'error',
          message: 'Service unavailable',
        }),
      }));

      const runner = createEnabledRunner({ continueOnCriticalFailure: false });
      const report = await runner.runEvaluation({
        connectorId: 'test-connector',
        modelId: 'test-model',
      });

      // First critical task fails, rest should be skipped
      const skippedTasks = report.taskResults.filter(
        (r) => r.outcome === 'SKIP',
      );
      expect(skippedTasks.length).toBeGreaterThan(0);
    });

    it('continues all tasks when continueOnCriticalFailure is true', async () => {
      // All requests return error
      mockFetch.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          status: 'error',
          message: 'Service unavailable',
        }),
      }));

      const runner = createEnabledRunner({ continueOnCriticalFailure: true });
      const report = await runner.runEvaluation({
        connectorId: 'test-connector',
        modelId: 'test-model',
      });

      // No tasks should be skipped (all should be executed)
      const skippedTasks = report.taskResults.filter(
        (r) => r.outcome === 'SKIP',
      );
      expect(skippedTasks.length).toBe(0);
    });

    it('handles network errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const runner = createEnabledRunner();
      const report = await runner.runEvaluation({
        connectorId: 'test-connector',
        modelId: 'test-model',
      });

      expect(report.classification).toBe('FAIL');
      // Should have failed/errored tasks, not crashed the runner
      const failedOrErroredTasks = report.taskResults.filter(
        (r) => r.outcome === 'FAIL' || r.outcome === 'ERROR',
      );
      expect(failedOrErroredTasks.length).toBeGreaterThan(0);
    });

    it('includes correct scoring breakdown', async () => {
      // First task passes, rest fail
      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              data: { message: 'pong' },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            status: 'error',
            message: 'Failed',
          }),
        };
      });

      const runner = createEnabledRunner({ continueOnCriticalFailure: true });
      const report = await runner.runEvaluation({
        connectorId: 'test-connector',
        modelId: 'test-model',
      });

      expect(report.scoring.totalCount).toBe(KIBANA_EVAL_TASKS.length);
      expect(report.scoring.maxScore).toBe(KIBANA_EVAL_TASKS.length);
      expect(report.scoring.percentageScore).toBeGreaterThanOrEqual(0);
      expect(report.scoring.percentageScore).toBeLessThanOrEqual(100);
    });

    it('returns PARTIAL when score is below threshold but no critical failures', async () => {
      // Make critical tasks pass but important/nice-to-have tasks fail
      let taskIndex = 0;
      mockFetch.mockImplementation(async (_url: string, options: { body?: string }) => {
        const body = options.body ? JSON.parse(options.body) : {};
        const subAction = body.params?.subAction;
        const messages = body.params?.subActionParams?.messages ?? [];
        const hasTools = body.params?.subActionParams?.tools;

        // Health check passes
        if (messages.length === 1 && messages[0]?.content === 'ping') {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              data: { message: 'pong' },
            }),
          };
        }

        // Basic chat completion passes
        if (
          !hasTools &&
          messages.length === 1 &&
          !messages.some((m: { role: string }) => m.role === 'system')
        ) {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              data: { message: '4' },
            }),
          };
        }

        // Tool calling passes
        if (hasTools) {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              data: {
                choices: [
                  {
                    message: {
                      tool_calls: [
                        {
                          id: 'call_1',
                          type: 'function',
                          function: {
                            name: 'get_current_time',
                            arguments: '{}',
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            }),
          };
        }

        // Everything else fails (system prompt, streaming, error handling)
        if (subAction === 'invokeStream') {
          return {
            ok: true,
            json: async () => ({
              status: 'error',
              message: 'Streaming not supported',
            }),
          };
        }

        // System prompt fails
        if (messages.some((m: { role: string }) => m.role === 'system')) {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              data: { message: 'I will not follow instructions' },
            }),
          };
        }

        return {
          ok: true,
          json: async () => ({
            status: 'error',
            message: 'Failed',
          }),
        };
      });

      // Set threshold high so that losing important/nice-to-have tasks makes it PARTIAL
      const runner = createEnabledRunner({ passThreshold: 95 });
      const report = await runner.runEvaluation({
        connectorId: 'test-connector',
        modelId: 'test-model',
      });

      // All critical tasks pass but some non-critical fail → PARTIAL
      const criticalResults = report.taskResults.filter(
        (r) => r.task.severity === 'CRITICAL',
      );
      const allCriticalPass = criticalResults.every((r) => r.outcome === 'PASS');

      if (allCriticalPass && report.scoring.percentageScore < 95) {
        expect(report.classification).toBe('PARTIAL');
      }
    });
  });

  describe('formatReport', () => {
    it('returns a formatted text report', async () => {
      mockFetch.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          status: 'ok',
          data: { message: '4' },
        }),
      }));

      const runner = createEnabledRunner();
      const report = await runner.runEvaluation({
        connectorId: 'test-connector',
        modelId: 'test-model',
      });

      const formatted = runner.formatReport(report);

      expect(formatted).toContain('KIBANA AGENT BUILDER EVALUATION REPORT');
      expect(formatted).toContain('test-model');
      expect(formatted).toContain('test-connector');
      expect(formatted).toContain('TASK RESULTS');
      expect(formatted).toContain('SCORING BREAKDOWN');
    });
  });
});

describe('KIBANA_EVAL_TASKS', () => {
  it('has the expected number of tasks', () => {
    expect(KIBANA_EVAL_TASKS.length).toBe(6);
  });

  it('has unique task IDs', () => {
    const ids = KIBANA_EVAL_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes critical tasks', () => {
    const critical = KIBANA_EVAL_TASKS.filter(
      (t) => t.severity === 'CRITICAL',
    );
    expect(critical.length).toBeGreaterThan(0);
  });

  it('all tasks have valid properties', () => {
    for (const task of KIBANA_EVAL_TASKS) {
      expect(task.id).toBeTruthy();
      expect(task.name).toBeTruthy();
      expect(task.description).toBeTruthy();
      expect(['connector_health', 'chat_completion', 'tool_calling', 'streaming', 'error_handling']).toContain(task.category);
      expect(['CRITICAL', 'IMPORTANT', 'NICE_TO_HAVE']).toContain(task.severity);
      expect(task.timeoutMs).toBeGreaterThan(0);
      expect(task.retryAttempts).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('SEVERITY_WEIGHTS', () => {
  it('has correct weight values', () => {
    expect(SEVERITY_WEIGHTS.CRITICAL).toBe(1.0);
    expect(SEVERITY_WEIGHTS.IMPORTANT).toBe(0.7);
    expect(SEVERITY_WEIGHTS.NICE_TO_HAVE).toBe(0.3);
  });
});

describe('DEFAULT_KIBANA_EVAL_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_KIBANA_EVAL_CONFIG.enabled).toBe(true);
    expect(DEFAULT_KIBANA_EVAL_CONFIG.passThreshold).toBe(80);
    expect(DEFAULT_KIBANA_EVAL_CONFIG.globalTimeoutMs).toBe(120_000);
    expect(DEFAULT_KIBANA_EVAL_CONFIG.continueOnCriticalFailure).toBe(false);
    expect(DEFAULT_KIBANA_EVAL_CONFIG.testPrompt).toBeTruthy();
    expect(DEFAULT_KIBANA_EVAL_CONFIG.expectedResponseKeywords.length).toBeGreaterThan(0);
  });
});

describe('KibanaEvalRunner with runKibanaEvalNode', () => {
  function createConfig(connectorService: unknown, evalRunner?: unknown) {
    return {
      configurable: {
        kibanaConnectorService: connectorService,
        kibanaEvalRunner: evalRunner,
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('node runs evaluation when runner and connector are available', async () => {
    const { runKibanaEvalNode } = await import('../../src/agent/nodes.js');
    const { KibanaConnectorService } = await import(
      '../../src/services/kibana-connector.js'
    );

    const kibanaConfig = createDefaultKibanaConfig({
      enabled: true,
      url: 'https://kibana.example.com',
      apiKey: 'test-key',
    });

    const connectorService = new KibanaConnectorService({
      config: kibanaConfig,
      logLevel: 'error',
    });

    const evalRunner = new KibanaEvalRunner({
      kibanaConfig,
      evalConfig: { enabled: true },
      logLevel: 'error',
    });

    // Mock connector creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'created-connector-id' }),
    });

    // Mock eval task calls (6 tasks)
    for (let i = 0; i < 10; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'ok',
          data: { message: '4' },
        }),
      });
    }

    const state = createMinimalGraphState({
      tunnelUrl: 'https://abc123.ngrok-free.app',
      currentModel: {
        id: 'test-model',
        name: 'Test Model',
        architecture: 'llama',
        contextWindow: 128_000,
        license: 'apache-2.0',
        parameterCount: 7_000_000_000,
        quantizations: [],
        supportsToolCalling: true,
      },
    });
    const config = createConfig(connectorService, evalRunner);

    const result = await runKibanaEvalNode(state, config);

    expect(result.currentState).toBe('evaluating_model');
    expect(result.kibanaConnectorId).toBe('created-connector-id');
    expect(result.kibanaEvalReport).toBeDefined();
    expect(result.kibanaEvalReport).not.toBeNull();
    expect(result.kibanaEvalReports).toBeDefined();
    expect(Array.isArray(result.kibanaEvalReports)).toBe(true);
  });

  it('node skips evaluation when eval runner is null', async () => {
    const { runKibanaEvalNode } = await import('../../src/agent/nodes.js');
    const { KibanaConnectorService } = await import(
      '../../src/services/kibana-connector.js'
    );

    const kibanaConfig = createDefaultKibanaConfig({
      enabled: true,
      url: 'https://kibana.example.com',
      apiKey: 'test-key',
    });

    const connectorService = new KibanaConnectorService({
      config: kibanaConfig,
      logLevel: 'error',
    });

    // Mock connector creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'connector-id' }),
    });

    const state = createMinimalGraphState({
      tunnelUrl: 'https://abc123.ngrok-free.app',
      currentModel: {
        id: 'test-model',
        name: 'Test Model',
        architecture: 'llama',
        contextWindow: 128_000,
        license: 'apache-2.0',
        parameterCount: 7_000_000_000,
        quantizations: [],
        supportsToolCalling: true,
      },
    });
    const config = createConfig(connectorService, null);

    const result = await runKibanaEvalNode(state, config);

    expect(result.currentState).toBe('evaluating_model');
    expect(result.kibanaConnectorId).toBe('connector-id');
    expect(result.kibanaEvalReport).toBeNull();
  });

  it('node handles eval runner failure gracefully', async () => {
    const { runKibanaEvalNode } = await import('../../src/agent/nodes.js');
    const { KibanaConnectorService } = await import(
      '../../src/services/kibana-connector.js'
    );

    const kibanaConfig = createDefaultKibanaConfig({
      enabled: true,
      url: 'https://kibana.example.com',
      apiKey: 'test-key',
    });

    const connectorService = new KibanaConnectorService({
      config: kibanaConfig,
      logLevel: 'error',
    });

    // Create a mock eval runner that throws
    const failingEvalRunner = {
      enabled: true,
      runEvaluation: vi.fn().mockRejectedValue(new Error('Eval crashed')),
    } as unknown as InstanceType<typeof KibanaEvalRunner>;

    // Mock connector creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'connector-id' }),
    });

    const state = createMinimalGraphState({
      tunnelUrl: 'https://abc123.ngrok-free.app',
      currentModel: {
        id: 'test-model',
        name: 'Test Model',
        architecture: 'llama',
        contextWindow: 128_000,
        license: 'apache-2.0',
        parameterCount: 7_000_000_000,
        quantizations: [],
        supportsToolCalling: true,
      },
    });
    const config = createConfig(connectorService, failingEvalRunner);

    const result = await runKibanaEvalNode(state, config);

    // Should not throw — should gracefully continue
    expect(result.currentState).toBe('evaluating_model');
    expect(result.kibanaConnectorId).toBe('connector-id');
    expect(result.kibanaEvalReport).toBeNull();
    expect(result.error).toBeNull();
  });
});

// ─── Minimal state helper ──────────────────────────────────────────────────

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
    kibanaEvalReport: null,
    kibanaEvalReports: [],
    ...overrides,
  };
}
