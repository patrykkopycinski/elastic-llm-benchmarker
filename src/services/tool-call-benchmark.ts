import type { ToolCallResult, ToolCallModeResult } from '../types/benchmark.js';
import { createLogger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Tool function definition for the chat completions API.
 * Follows the OpenAI-compatible tool calling specification.
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required: string[];
    };
  };
}

/**
 * A single tool call returned from the chat completions API response.
 */
export interface ParsedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Result of a single parallel tool call test iteration.
 */
export interface ParallelToolCallTestResult {
  /** Number of tool calls requested in the prompt */
  requestedCalls: number;
  /** Number of tool calls actually returned by the model */
  returnedCalls: number;
  /** Whether the model produced all requested tool calls in a single response */
  allCallsReturned: boolean;
  /** Whether all returned tool calls had valid function names and parseable arguments */
  allCallsValid: boolean;
  /** Names of functions that were correctly called */
  validFunctionNames: string[];
  /** Total latency for the API request in milliseconds */
  latencyMs: number;
  /** Error message if the test failed */
  error: string | null;
}

/**
 * Aggregated results from the full parallel tool calling benchmark suite.
 */
export interface ToolCallBenchmarkReport {
  /** Standard ToolCallResult for integration with BenchmarkResult */
  toolCallResult: ToolCallResult;
  /** Detailed per-test results */
  testDetails: ParallelToolCallTestResult[];
  /** Whether all pass/fail criteria were met */
  passed: boolean;
  /** Reasons for failure, if any */
  failureReasons: string[];
}

/**
 * Configuration options for the tool call benchmark.
 */
export interface ToolCallBenchmarkOptions {
  /** Base URL for the chat completions API (e.g., "http://localhost:8000") */
  baseUrl: string;
  /** Model name to use in the API request */
  model: string;
  /** Maximum latency in milliseconds for tool calls to pass (default: 1000) */
  maxLatencyMs?: number;
  /** Minimum success rate required to pass (0-1, default: 1.0) */
  minSuccessRate?: number;
  /** Request timeout in milliseconds (default: 30000) */
  requestTimeoutMs?: number;
  /** Number of test iterations per scenario (default: 3) */
  iterationsPerScenario?: number;
  /** Log level for the service logger */
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

/**
 * get_weather tool definition for testing parallel tool calls.
 */
export const GET_WEATHER_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a specific location.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'The city and state/country, e.g., "San Francisco, CA"',
        },
        unit: {
          type: 'string',
          description: 'Temperature unit',
          enum: ['celsius', 'fahrenheit'],
        },
      },
      required: ['location'],
    },
  },
};

/**
 * get_stock_price tool definition for testing parallel tool calls.
 */
export const GET_STOCK_PRICE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_stock_price',
    description: 'Get the current stock price for a given ticker symbol.',
    parameters: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'The stock ticker symbol, e.g., "AAPL"',
        },
        currency: {
          type: 'string',
          description: 'Currency for the price',
          enum: ['USD', 'EUR', 'GBP'],
        },
      },
      required: ['symbol'],
    },
  },
};

// ─── Test Scenarios ─────────────────────────────────────────────────────────

/**
 * Defines a parallel tool call test scenario with a prompt designed to
 * trigger multiple tool calls in a single response.
 */
export interface TestScenario {
  /** Human-readable name for this scenario */
  name: string;
  /** The user prompt that should trigger multiple tool calls */
  prompt: string;
  /** Tool definitions to provide to the model */
  tools: ToolDefinition[];
  /** Expected function names in the response */
  expectedFunctions: string[];
  /** Minimum number of tool calls expected */
  expectedMinCalls: number;
}

/**
 * Pre-defined test scenarios for tool calling: sequential (single call) and parallel (multiple calls).
 * Sequential scenario verifies basic tool-call capability; parallel scenarios verify multi-call in one response.
 */
export const TEST_SCENARIOS: TestScenario[] = [
  {
    name: 'single-weather-lookup',
    prompt: 'What is the current weather in San Francisco, CA?',
    tools: [GET_WEATHER_TOOL],
    expectedFunctions: ['get_weather'],
    expectedMinCalls: 1,
  },
  {
    name: 'dual-weather-lookup',
    prompt:
      'What is the current weather in San Francisco, CA and Tokyo, Japan? Please check both locations.',
    tools: [GET_WEATHER_TOOL],
    expectedFunctions: ['get_weather'],
    expectedMinCalls: 2,
  },
  {
    name: 'triple-stock-lookup',
    prompt:
      'I need the current stock prices for AAPL, GOOGL, and MSFT. Look up all three right now.',
    tools: [GET_STOCK_PRICE_TOOL],
    expectedFunctions: ['get_stock_price'],
    expectedMinCalls: 3,
  },
  {
    name: 'mixed-weather-and-stocks',
    prompt:
      'Get me the weather in London, UK and New York, NY, and also the stock prices for TSLA and AMZN. I need all of this information.',
    tools: [GET_WEATHER_TOOL, GET_STOCK_PRICE_TOOL],
    expectedFunctions: ['get_weather', 'get_stock_price'],
    expectedMinCalls: 4,
  },
  {
    name: 'five-location-weather',
    prompt:
      'Check the weather in all of these cities at once: Paris, Berlin, Sydney, Mumbai, and Toronto.',
    tools: [GET_WEATHER_TOOL],
    expectedFunctions: ['get_weather'],
    expectedMinCalls: 5,
  },
];

// ─── Service Implementation ─────────────────────────────────────────────────

/**
 * Service for benchmarking parallel tool calling capabilities via the
 * OpenAI-compatible chat completions API (as served by vLLM).
 *
 * Tests whether the model can produce multiple tool calls in a single
 * response and measures latency and success rate.
 */
export class ToolCallBenchmarkService {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxLatencyMs: number;
  private readonly minSuccessRate: number;
  private readonly requestTimeoutMs: number;
  private readonly iterationsPerScenario: number;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(options: ToolCallBenchmarkOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.maxLatencyMs = options.maxLatencyMs ?? 1000;
    this.minSuccessRate = options.minSuccessRate ?? 1.0;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.iterationsPerScenario = options.iterationsPerScenario ?? 3;
    this.logger = createLogger(options.logLevel ?? 'info');
  }

  /**
   * Build the chat completions request body for a test scenario.
   *
   * @param scenario - The test scenario
   * @param toolChoice - "auto" lets the model decide; "required" forces tool calling via guided decoding
   */
  buildRequestBody(
    scenario: TestScenario,
    toolChoice: 'auto' | 'required' = 'auto',
  ): Record<string, unknown> {
    return {
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful assistant. When the user asks for information that requires tool calls, use the available tools. Make all necessary tool calls in parallel in a single response.',
        },
        {
          role: 'user',
          content: scenario.prompt,
        },
      ],
      tools: scenario.tools,
      tool_choice: toolChoice,
      temperature: 0,
      max_tokens: 1024,
    };
  }

  /**
   * Parse tool calls from a chat completions API response.
   * Returns an array of parsed tool calls, or an empty array on failure.
   */
  parseToolCallsFromResponse(responseBody: unknown): ParsedToolCall[] {
    if (!responseBody || typeof responseBody !== 'object') {
      return [];
    }

    const body = responseBody as Record<string, unknown>;
    const choices = body['choices'];

    if (!Array.isArray(choices) || choices.length === 0) {
      return [];
    }

    const firstChoice = choices[0] as Record<string, unknown> | undefined;
    if (!firstChoice) {
      return [];
    }

    const message = firstChoice['message'] as Record<string, unknown> | undefined;
    if (!message) {
      return [];
    }

    const toolCalls = message['tool_calls'];
    if (!Array.isArray(toolCalls)) {
      return [];
    }

    return toolCalls.filter(
      (tc): tc is ParsedToolCall =>
        typeof tc === 'object' &&
        tc !== null &&
        typeof (tc as Record<string, unknown>)['id'] === 'string' &&
        typeof (tc as Record<string, unknown>)['type'] === 'string' &&
        typeof (
          (tc as Record<string, unknown>)['function'] as Record<string, unknown> | undefined
        )?.['name'] === 'string' &&
        typeof (
          (tc as Record<string, unknown>)['function'] as Record<string, unknown> | undefined
        )?.['arguments'] === 'string',
    );
  }

  /**
   * Validate that parsed tool calls match the expected functions for a scenario.
   * Returns the list of valid function names that were correctly called.
   */
  validateToolCalls(toolCalls: ParsedToolCall[], scenario: TestScenario): string[] {
    const validNames: string[] = [];

    for (const tc of toolCalls) {
      const fnName = tc.function.name;

      // Check if the function name matches one of the expected functions
      if (!scenario.expectedFunctions.includes(fnName)) {
        continue;
      }

      // Try to parse the arguments as JSON
      try {
        const args = JSON.parse(tc.function.arguments) as unknown;
        if (typeof args === 'object' && args !== null) {
          validNames.push(fnName);
        }
      } catch {
        // Invalid JSON arguments - skip this tool call
        this.logger.debug(
          `Invalid JSON arguments for tool call ${tc.id}: ${tc.function.arguments}`,
        );
      }
    }

    return validNames;
  }

  /**
   * Execute a single test scenario against the chat completions API.
   * Sends the request and measures latency, then validates tool calls.
   */
  async executeScenario(
    scenario: TestScenario,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
    toolChoice: 'auto' | 'required' = 'auto',
  ): Promise<ParallelToolCallTestResult> {
    const requestBody = this.buildRequestBody(scenario, toolChoice);
    const url = `${this.baseUrl}/v1/chat/completions`;

    const startTime = performance.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const latencyMs = performance.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        return {
          requestedCalls: scenario.expectedMinCalls,
          returnedCalls: 0,
          allCallsReturned: false,
          allCallsValid: false,
          validFunctionNames: [],
          latencyMs,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      const responseBody = (await response.json()) as unknown;
      const toolCalls = this.parseToolCallsFromResponse(responseBody);
      const validNames = this.validateToolCalls(toolCalls, scenario);

      const allCallsReturned = toolCalls.length >= scenario.expectedMinCalls;
      const allCallsValid =
        validNames.length >= scenario.expectedMinCalls && validNames.length === toolCalls.length;

      return {
        requestedCalls: scenario.expectedMinCalls,
        returnedCalls: toolCalls.length,
        allCallsReturned,
        allCallsValid,
        validFunctionNames: validNames,
        latencyMs,
        error: null,
      };
    } catch (err) {
      const latencyMs = performance.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      return {
        requestedCalls: scenario.expectedMinCalls,
        returnedCalls: 0,
        allCallsReturned: false,
        allCallsValid: false,
        validFunctionNames: [],
        latencyMs,
        error: message,
      };
    }
  }

  /**
   * Run the benchmark for a single tool_choice mode.
   */
  private async runMode(
    mode: 'auto' | 'required',
    scenarios: TestScenario[],
    fetchFn: typeof globalThis.fetch,
  ): Promise<{ results: ParallelToolCallTestResult[]; maxConcurrentCalls: number }> {
    this.logger.info(`Running tool call benchmark in "${mode}" mode`, {
      scenarios: scenarios.length,
      iterationsPerScenario: this.iterationsPerScenario,
    });

    const results: ParallelToolCallTestResult[] = [];
    let maxConcurrentCalls = 0;

    for (const scenario of scenarios) {
      this.logger.info(`Running scenario: ${scenario.name} [${mode}]`, {
        expectedMinCalls: scenario.expectedMinCalls,
        iterations: this.iterationsPerScenario,
      });

      for (let i = 0; i < this.iterationsPerScenario; i++) {
        const result = await this.executeScenario(scenario, fetchFn, mode);

        this.logger.debug(`Scenario "${scenario.name}" [${mode}] iteration ${i + 1}`, {
          returnedCalls: result.returnedCalls,
          allCallsReturned: result.allCallsReturned,
          latencyMs: result.latencyMs.toFixed(2),
          error: result.error,
        });

        results.push(result);

        if (result.returnedCalls > maxConcurrentCalls) {
          maxConcurrentCalls = result.returnedCalls;
        }
      }
    }

    return { results, maxConcurrentCalls };
  }

  /**
   * Run the full tool calling benchmark suite.
   *
   * Runs two passes:
   * 1. **auto** — model decides when to emit tool calls (tests native ability)
   * 2. **required** — vLLM forces tool calls via guided decoding (workaround for
   *    models like Llama 3.3 whose native format doesn't match the parser)
   *
   * The top-level result reflects the best-case across modes.
   * Per-mode breakdowns are in `toolCallResult.modeResults`.
   */
  async runBenchmark(
    scenarios: TestScenario[] = TEST_SCENARIOS,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<ToolCallBenchmarkReport> {
    this.logger.info('Starting tool call benchmark (auto + required modes)', {
      scenarios: scenarios.length,
      iterationsPerScenario: this.iterationsPerScenario,
      model: this.model,
      baseUrl: this.baseUrl,
    });

    const autoRun = await this.runMode('auto', scenarios, fetchFn);
    const autoReport = this.aggregateResults(autoRun.results, autoRun.maxConcurrentCalls);

    const requiredRun = await this.runMode('required', scenarios, fetchFn);
    const requiredReport = this.aggregateResults(requiredRun.results, requiredRun.maxConcurrentCalls);

    const autoMode: ToolCallModeResult = {
      toolChoiceMode: 'auto',
      ...autoReport.toolCallResult,
    };
    const requiredMode: ToolCallModeResult = {
      toolChoiceMode: 'required',
      ...requiredReport.toolCallResult,
    };

    // Pick the best mode for top-level summary
    const bestSuccessRate = Math.max(autoMode.successRate, requiredMode.successRate);
    const bestMode = autoMode.successRate >= requiredMode.successRate ? autoMode : requiredMode;
    const combinedTotalTests = autoMode.totalTests + requiredMode.totalTests;

    const toolCallResult: ToolCallResult = {
      supportsParallelCalls: autoMode.supportsParallelCalls || requiredMode.supportsParallelCalls,
      maxConcurrentCalls: Math.max(autoMode.maxConcurrentCalls, requiredMode.maxConcurrentCalls),
      avgToolCallLatencyMs: bestMode.avgToolCallLatencyMs,
      successRate: bestSuccessRate,
      totalTests: combinedTotalTests,
      modeResults: [autoMode, requiredMode],
    };

    const failureReasons: string[] = [];
    if (!toolCallResult.supportsParallelCalls) {
      failureReasons.push('Parallel calls not supported in any mode');
    }
    if (bestSuccessRate < this.minSuccessRate) {
      failureReasons.push(
        `Best success rate ${(bestSuccessRate * 100).toFixed(2)}% (auto: ${(autoMode.successRate * 100).toFixed(2)}%, required: ${(requiredMode.successRate * 100).toFixed(2)}%) is below minimum ${(this.minSuccessRate * 100).toFixed(2)}%`,
      );
    }

    const passed = failureReasons.length === 0;

    this.logger.info('Tool call benchmark complete (both modes)', {
      passed,
      autoSuccessRate: (autoMode.successRate * 100).toFixed(2) + '%',
      requiredSuccessRate: (requiredMode.successRate * 100).toFixed(2) + '%',
      autoParallel: autoMode.supportsParallelCalls,
      requiredParallel: requiredMode.supportsParallelCalls,
      totalTests: combinedTotalTests,
    });

    return {
      toolCallResult,
      testDetails: [...autoRun.results, ...requiredRun.results],
      passed,
      failureReasons,
    };
  }

  /**
   * Aggregate individual test results into a final benchmark report.
   */
  aggregateResults(
    results: ParallelToolCallTestResult[],
    maxConcurrentCalls: number,
  ): ToolCallBenchmarkReport {
    const totalTests = results.length;
    const successfulTests = results.filter(
      (r) => r.allCallsReturned && r.allCallsValid && r.error === null,
    );
    const successRate = totalTests > 0 ? successfulTests.length / totalTests : 0;

    const latencies = results.filter((r) => r.error === null).map((r) => r.latencyMs);
    const avgLatencyMs =
      latencies.length > 0 ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length : 0;

    // Parallel call support: all tests must have returned all requested calls
    const parallelCallTests = results.filter((r) => r.requestedCalls > 1 && r.error === null);
    const parallelCallSuccesses = parallelCallTests.filter((r) => r.allCallsReturned);
    const supportsParallelCalls =
      parallelCallTests.length > 0 && parallelCallSuccesses.length === parallelCallTests.length;

    const toolCallResult: ToolCallResult = {
      supportsParallelCalls,
      maxConcurrentCalls,
      avgToolCallLatencyMs: Math.round(avgLatencyMs * 100) / 100,
      successRate: Math.round(successRate * 10000) / 10000,
      totalTests,
    };

    // Determine pass/fail
    const failureReasons: string[] = [];

    if (!supportsParallelCalls) {
      failureReasons.push(
        `Parallel call support is not 100%: ${parallelCallSuccesses.length}/${parallelCallTests.length} tests returned all requested calls`,
      );
    }

    if (avgLatencyMs > this.maxLatencyMs) {
      failureReasons.push(
        `Average tool call latency ${avgLatencyMs.toFixed(2)}ms exceeds maximum ${this.maxLatencyMs}ms`,
      );
    }

    if (successRate < this.minSuccessRate) {
      failureReasons.push(
        `Success rate ${(successRate * 100).toFixed(2)}% is below minimum ${(this.minSuccessRate * 100).toFixed(2)}%`,
      );
    }

    const passed = failureReasons.length === 0;

    this.logger.info('Parallel tool call benchmark complete', {
      passed,
      supportsParallelCalls,
      maxConcurrentCalls,
      avgLatencyMs: avgLatencyMs.toFixed(2),
      successRate: (successRate * 100).toFixed(2) + '%',
      totalTests,
      failureReasons: failureReasons.length > 0 ? failureReasons : undefined,
    });

    return {
      toolCallResult,
      testDetails: results,
      passed,
      failureReasons,
    };
  }
}
